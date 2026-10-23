/* 中醫 AI 病歷助手 — 純前端（GitHub Pages）
 * 錄音：MediaRecorder → 記憶體＋IndexedDB（重新整理也找得回）
 * AI：Google Gemini（預設，免費額度；一次呼叫回傳逐字稿＋病歷）或 xAI（/v1/stt + /v1/chat/completions）
 * 寄信：使用者自己部署的 Google Apps Script 中繼（mail_relay.gs）；備援 mailto: 與複製
 */
(function () {
  'use strict';
  var APP_VERSION = '2.0.0';
  var $ = function (id) { return document.getElementById(id); };

  // ---------------- 常數 ----------------
  var GEMINI_BASE = 'https://generativelanguage.googleapis.com';
  var GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';
  var GEMINI_FALLBACKS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite'];
  var GEMINI_INLINE_MAX = 14 * 1024 * 1024;   // 官方上限：整個請求 20 MB（base64 會膨脹 4/3）
  var XAI_BASE = 'https://api.x.ai/v1';
  var XAI_STT_MODEL = 'grok-voice-transcribe-2.0';
  var XAI_DEFAULT_MODEL = 'grok-4.20-non-reasoning';
  var XAI_FALLBACKS = ['grok-4.3'];
  var TIMESLICE_MS = 5000;
  var REQ_TIMEOUT_MS = 15 * 60 * 1000;

  // ---------------- 設定（localStorage） ----------------
  var LS = 'tcmScribe2.';
  var DEFAULTS = {
    provider: 'gemini', geminiKey: '', geminiModel: '', xaiKey: '', xaiModel: '',
    recipient: '', relayUrl: '', relayToken: '',
    autoSend: '1', attachTranscript: '1', toTraditional: '1', keepAudio: '1',
    language: 'zh', extraTerms: ''
  };
  function getS(k) { try { var v = localStorage.getItem(LS + k); return v === null ? DEFAULTS[k] : v; } catch (e) { return DEFAULTS[k]; } }
  function setS(k, v) { try { localStorage.setItem(LS + k, v); } catch (e) {} }
  var sess = {
    get: function (k) { try { return sessionStorage.getItem(LS + k) || ''; } catch (e) { return ''; } },
    set: function (k, v) { try { sessionStorage.setItem(LS + k, v); } catch (e) {} }
  };

  // ---------------- IndexedDB（錄音片段） ----------------
  var DB_NAME = 'tcmScribe2', db = null;
  function openDB() {
    if (db) return Promise.resolve(db);
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no indexedDB')); return; }
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
        if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks');
      };
      req.onsuccess = function () { db = req.result; resolve(db); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idb(store, mode, fn) {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(store, mode), st = tx.objectStore(store), out;
        var r = fn(st); if (r) r.onsuccess = function () { out = r.result; };
        tx.oncomplete = function () { resolve(out); };
        tx.onerror = tx.onabort = function () { reject(tx.error); };
      });
    });
  }
  var audioStore = {
    // 只保留「目前這一段」錄音：meta.current = {id, mime, startedAt, status, name, size}
    start: function (meta) {
      return idb('chunks', 'readwrite', function (st) { st.clear(); })
        .then(function () { return idb('meta', 'readwrite', function (st) { st.put(meta, 'current'); }); });
    },
    putChunk: function (seq, blob) { return idb('chunks', 'readwrite', function (st) { st.put(blob, ('00000' + seq).slice(-6)); }); },
    setMeta: function (meta) { return idb('meta', 'readwrite', function (st) { st.put(meta, 'current'); }); },
    getMeta: function () { return idb('meta', 'readonly', function (st) { return st.get('current'); }); },
    getBlob: function (mime) {
      return openDB().then(function (d) {
        return new Promise(function (resolve, reject) {
          var parts = [], tx = d.transaction('chunks', 'readonly'), req = tx.objectStore('chunks').openCursor();
          req.onsuccess = function () { var c = req.result; if (c) { parts.push(c.value); c.continue(); } };
          tx.oncomplete = function () { resolve(parts.length ? new Blob(parts, { type: mime || (parts[0] && parts[0].type) || '' }) : null); };
          tx.onerror = function () { reject(tx.error); };
        });
      });
    },
    saveWhole: function (blob, meta) {
      return audioStore.start(meta).then(function () { return audioStore.putChunk(0, blob); });
    },
    clear: function () {
      return idb('chunks', 'readwrite', function (st) { st.clear(); })
        .then(function () { return idb('meta', 'readwrite', function (st) { st.delete('current'); }); });
    }
  };

  // ---------------- 狀態列 / 計時 ----------------
  function setStatus(cls, text) { $('status').className = 'pill ' + cls; $('statusText').textContent = text; }
  var startTime = null, tick = null;
  function mb(n) { return n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  function fmt(sec) { sec = Math.max(0, Math.round(sec)); var m = Math.floor(sec / 60), s = sec % 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; }
  function startTimer() { startTime = Date.now(); $('timer').textContent = '00:00'; tick = setInterval(function () { $('timer').textContent = fmt((Date.now() - startTime) / 1000); }, 500); }
  function stopTimer() { clearInterval(tick); tick = null; }
  function taipeiStamp(d) {
    var p = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    return p.year + '/' + p.month + '/' + p.day + ' ' + (p.hour === '24' ? '00' : p.hour) + ':' + p.minute;
  }
  function msg(id, t, cls) { $(id).textContent = t || ''; $(id).className = 'msg ' + (cls || ''); }
  function hint(t, cls) { $('recHint').textContent = t; $('recHint').className = 'hint' + (cls ? ' ' + cls : ''); }
  function step(id, state) { var el = $(id); if (el) el.className = 'step' + (state ? ' ' + state : ''); }
  function progress(text) { $('progress').hidden = false; $('progressText').textContent = text || ''; }

  // ---------------- 錄音 ----------------
  var rec = null, stream = null, chunks = [], seq = 0, recMime = '', recording = false, wakeLock = null;
  var meterCtx = null, meterRAF = 0, currentAudio = null; // currentAudio = {blob, name, startedAt}

  function pickMime() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    // Gemini 官方列出 audio/webm、m4a、aac、ogg…；xAI 官方列出 mp4/m4a/aac/ogg/opus/mkv（未明列 webm）
    var gem = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus'];
    var xai = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'];
    var list = getS('provider') === 'xai' ? xai : gem;
    for (var i = 0; i < list.length; i++) if (MediaRecorder.isTypeSupported(list[i])) return list[i];
    return '';
  }
  function extFor(mime) {
    mime = (mime || '').toLowerCase();
    if (mime.indexOf('mp4') >= 0 || mime.indexOf('m4a') >= 0 || mime.indexOf('aac') >= 0) return 'm4a';
    if (mime.indexOf('webm') >= 0) return 'webm';
    if (mime.indexOf('ogg') >= 0) return 'ogg';
    if (mime.indexOf('wav') >= 0) return 'wav';
    if (mime.indexOf('mpeg') >= 0 || mime.indexOf('mp3') >= 0) return 'mp3';
    if (mime.indexOf('flac') >= 0) return 'flac';
    return 'bin';
  }

  function startRecording() {
    if (recording) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      hint('此瀏覽器不支援網頁錄音。請改用手機內建錄音 App 錄好，再按下方「選擇已錄好的音檔」。', 'err'); return;
    }
    if (!window.isSecureContext) { hint('錄音需要 HTTPS 網址。', 'err'); return; }
    var go = function () {
      return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
        .then(function (s) {
          stream = s; chunks = []; seq = 0; recMime = pickMime();
          var opts = { audioBitsPerSecond: 48000 }; if (recMime) opts.mimeType = recMime;
          try { rec = new MediaRecorder(stream, opts); } catch (e) { rec = new MediaRecorder(stream); }
          recMime = rec.mimeType || recMime || 'audio/webm';
          var startedAt = Date.now();
          var meta = { id: String(startedAt), mime: recMime, startedAt: startedAt, status: 'recording', name: '' };
          audioStore.start(meta).catch(function () {});
          rec.ondataavailable = function (ev) {
            if (!ev.data || !ev.data.size) return;
            chunks.push(ev.data); var n = seq++;
            audioStore.putChunk(n, ev.data).catch(function () {});
          };
          rec.onerror = function (ev) { hint('錄音發生錯誤：' + ((ev.error && ev.error.name) || '未知') + '。已錄到的部分仍保留。', 'err'); };
          stream.getAudioTracks().forEach(function (t) {
            t.onended = function () { if (recording) hint('⚠️ 麥克風被系統中斷（可能切到其他 App 或接電話）。已錄到的部分已保存，請按「結束並產生病歷」。', 'warn'); };
          });
          rec.start(TIMESLICE_MS);
          recording = true;
          $('btnStart').disabled = true; $('btnStop').disabled = false; $('fileInput').disabled = true;
          setStatus('recording', '錄音中'); startTimer(); startMeter(stream);
          hint('錄音中…錄音只存在這支手機，不需要網路。請保持畫面開啟、不要切換 App 或鎖定螢幕。');
          if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (w) { wakeLock = w; }).catch(function () {});
          $('recoverBox').hidden = true;
          if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
        });
    };
    var confirmOverwrite = currentAudio ? Promise.resolve(confirm('開始新的錄音會取代上一段錄音（及逐字稿、病歷），確定嗎？')) : Promise.resolve(true);
    confirmOverwrite.then(function (ok) {
      if (!ok) return;
      clearSessionText();
      currentAudio = null; updateAudioButtons();
      return go();
    }).catch(function (e) {
      var n = e && e.name;
      if (n === 'NotAllowedError' || n === 'SecurityError') hint('無法使用麥克風：請允許此網站使用麥克風（iPhone：設定 > Safari > 麥克風；Android：網址列左側鎖頭 > 權限）。', 'err');
      else if (n === 'NotFoundError') hint('找不到麥克風。', 'err');
      else hint('無法開始錄音：' + (e && e.message || e), 'err');
      setStatus('error', '錯誤');
    });
  }

  function stopRecording() {
    if (!recording || !rec) return Promise.resolve(null);
    recording = false;
    $('btnStop').disabled = true;
    return new Promise(function (resolve) {
      rec.onstop = function () {
        stopTimer(); stopMeter();
        if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
        if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
        var blob = new Blob(chunks, { type: recMime });
        var dur = (Date.now() - startTime) / 1000;
        currentAudio = { blob: blob, name: 'visit-' + startTime + '.' + extFor(recMime), startedAt: startTime, duration: dur };
        audioStore.getMeta().then(function (m) {
          if (m) { m.status = 'stopped'; m.duration = dur; m.size = blob.size; return audioStore.setMeta(m); }
        }).catch(function () {});
        $('btnStart').disabled = false; $('fileInput').disabled = false;
        hint('錄音已結束（' + fmt(dur) + '，' + mb(blob.size) + '），已保存在手機。');
        updateAudioButtons();
        resolve(currentAudio);
      };
      try { rec.requestData(); } catch (e) {}
      try { rec.stop(); } catch (e) { rec.onstop(); }
    });
  }

  function startMeter(s) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      meterCtx = new AC(); var src = meterCtx.createMediaStreamSource(s), an = meterCtx.createAnalyser();
      an.fftSize = 512; src.connect(an); var buf = new Uint8Array(an.fftSize);
      var loop = function () {
        an.getByteTimeDomainData(buf); var peak = 0;
        for (var i = 0; i < buf.length; i++) { var v = Math.abs(buf[i] - 128); if (v > peak) peak = v; }
        $('meterBar').style.width = Math.min(100, peak / 128 * 180) + '%';
        meterRAF = requestAnimationFrame(loop);
      };
      loop();
    } catch (e) {}
  }
  function stopMeter() { cancelAnimationFrame(meterRAF); $('meterBar').style.width = '0'; if (meterCtx) { try { meterCtx.close(); } catch (e) {} meterCtx = null; } }

  // ---------------- 共用：網路請求 ----------------
  function fetchT(url, opts, ms) {
    var ctl = window.AbortController ? new AbortController() : null, timer;
    if (ctl) { opts.signal = ctl.signal; timer = setTimeout(function () { ctl.abort(); }, ms || REQ_TIMEOUT_MS); }
    return fetch(url, opts).then(function (r) { clearTimeout(timer); return r; }, function (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('連線逾時（超過 ' + Math.round((ms || REQ_TIMEOUT_MS) / 60000) + ' 分鐘）。');
      throw new Error('網路連線失敗（' + (e && e.message || e) + '）。請確認手機有網路後按「重新辨識錄音」。');
    });
  }
  function readErr(r) {
    return r.text().then(function (t) {
      var m = t;
      try { var j = JSON.parse(t); m = (j.error && (j.error.message || j.error)) || j.message || t; if (typeof m !== 'string') m = JSON.stringify(m); } catch (e) {}
      var e = new Error(String(m).slice(0, 400)); e.status = r.status; return e;
    });
  }
  function friendly(provider, e) {
    var s = e.status, m = e.message || '';
    if (provider === 'gemini') {
      if (s === 400 && /API key/i.test(m)) return 'Gemini 金鑰錯誤，請到設定重新貼上（AI Studio 的 API 金鑰）。';
      if (s === 429) return 'Gemini 免費額度已用完或請求太頻繁（每日額度於台灣時間下午 3～4 點重置，依美西午夜）。可稍後再試，或在設定改用 xAI。\n' + m;
      if (s === 403) return 'Gemini 拒絕存取（金鑰可能被限制或此地區不提供）：' + m;
    } else {
      if (/API key/i.test(m) || s === 401) return 'xAI 金鑰錯誤，請到設定重新貼上（console.x.ai 的 API 金鑰）。';
      if (s === 403 || /credit|spending|balance/i.test(m)) return 'xAI 帳戶額度不足，請到 console.x.ai 儲值：' + m;
      if (s === 429) return 'xAI 請求太頻繁，請稍後再試。';
    }
    return (provider === 'gemini' ? 'Gemini' : 'xAI') + ' 錯誤' + (s ? '（HTTP ' + s + '）' : '') + '：' + m;
  }
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { var s = String(fr.result); resolve(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }
  function keyterms() {
    var extra = (getS('extraTerms') || '').split(/[,，、;\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    var all = extra.concat(window.TCM_DEFAULT_KEYTERMS || []), seen = {}, out = [];
    all.forEach(function (t) { t = t.slice(0, 50); if (!seen[t]) { seen[t] = 1; out.push(t); } });
    return out.slice(0, 100);
  }

  // ---------------- Gemini（一次呼叫：逐字稿＋病歷） ----------------
  function geminiMime(blob, name) {
    var t = (blob.type || '').split(';')[0].toLowerCase(), ext = (name || '').split('.').pop().toLowerCase();
    var byExt = { m4a: 'audio/m4a', mp4: 'audio/m4a', aac: 'audio/aac', mp3: 'audio/mp3', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac', webm: 'audio/webm', aiff: 'audio/aiff', aif: 'audio/aiff', '3gp': 'audio/3gpp', amr: 'audio/amr' };
    if (t === 'audio/mp4' || t === 'video/mp4' || t === 'audio/x-m4a' || t === 'audio/m4a') return 'audio/m4a';
    if (t === 'audio/mpeg' || t === 'audio/mp3') return 'audio/mp3';
    if (t === 'audio/x-wav' || t === 'audio/wave') return 'audio/wav';
    if (t === 'video/webm') return 'audio/webm';
    if (t && t.indexOf('audio/') === 0) return t;
    return byExt[ext] || 'audio/webm';
  }
  function geminiUpload(key, blob, mime, onProg) {
    onProg('上傳錄音到 Gemini（' + (blob.size / 1048576).toFixed(1) + ' MB）…');
    return fetchT(GEMINI_BASE + '/upload/v1beta/files', {
      method: 'POST',
      headers: {
        'x-goog-api-key': key, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(blob.size), 'X-Goog-Upload-Header-Content-Type': mime, 'Content-Type': 'application/json'
      },
      body: JSON.stringify({ file: { display_name: 'tcm-visit-' + Date.now() } })
    }).then(function (r) {
      if (!r.ok) return readErr(r).then(function (e) { throw e; });
      var url = r.headers.get('x-goog-upload-url');
      if (!url) throw new Error('Gemini 上傳失敗：瀏覽器讀不到上傳網址（x-goog-upload-url）。請改用較短的錄音（約 30 分鐘內）。');
      return fetchT(url, { method: 'POST', headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: blob });
    }).then(function (r) {
      if (!r.ok) return readErr(r).then(function (e) { throw e; });
      return r.json();
    }).then(function (j) {
      var f = j.file || j, tries = 0;
      var poll = function () {
        if (!f.state || f.state === 'ACTIVE') return f;
        if (f.state === 'FAILED') throw new Error('Gemini 無法處理這個音檔格式。');
        if (++tries > 60) throw new Error('Gemini 處理音檔逾時。');
        onProg('Gemini 正在處理音檔…');
        return new Promise(function (res) { setTimeout(res, 2000); }).then(function () {
          return fetchT(GEMINI_BASE + '/v1beta/' + f.name, { headers: { 'x-goog-api-key': key } }, 30000);
        }).then(function (r) { return r.json(); }).then(function (x) { f = x; return poll(); });
      };
      return poll();
    });
  }
  function geminiGenerate(key, model, parts) {
    var body = {
      systemInstruction: { parts: [{ text: window.TCM_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: parts }],
      generationConfig: {
        temperature: 0.2, maxOutputTokens: 32768, responseMimeType: 'application/json',
        responseSchema: { type: 'OBJECT', properties: { transcript: { type: 'STRING' }, record: { type: 'STRING' } }, required: ['transcript', 'record'] }
      }
    };
    if (/^gemini-([3-9]|\d\d)/.test(model)) body.generationConfig.thinkingConfig = { thinkingLevel: 'low' };
    return fetchT(GEMINI_BASE + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) return readErr(r).then(function (e) { throw e; });
      return r.json();
    }).then(function (j) {
      var c = j.candidates && j.candidates[0];
      var text = ((c && c.content && c.content.parts) || []).filter(function (p) { return p.text && !p.thought; }).map(function (p) { return p.text; }).join('');
      if (!text) { var e = new Error('沒有回傳內容（' + ((c && c.finishReason) || (j.promptFeedback && j.promptFeedback.blockReason) || '未知') + '）'); e.status = 0; throw e; }
      var out;
      try { out = JSON.parse(text); } catch (err) {
        var m = text.match(/\{[\s\S]*\}/); try { out = m && JSON.parse(m[0]); } catch (e2) { out = null; }
        if (!out) out = { transcript: '', record: text };
      }
      if (c.finishReason === 'MAX_TOKENS') out.record = (out.record || '') + '\n\n（⚠️ 輸出長度已達上限，內容可能不完整）';
      return { transcript: String(out.transcript || ''), record: String(out.record || ''), model: model };
    });
  }
  function geminiModels() {
    var m = (getS('geminiModel') || '').trim() || GEMINI_DEFAULT_MODEL;
    return [m].concat([GEMINI_DEFAULT_MODEL].concat(GEMINI_FALLBACKS).filter(function (x) { return x !== m; }));
  }
  function withFallback(models, fn, provider) {
    var i = 0, last;
    var next = function () {
      if (i >= models.length) throw last;
      var model = models[i++];
      return fn(model).catch(function (e) {
        last = e;
        // 額度用完 / 模型不存在 / 暫時故障 → 換下一個模型；金鑰錯誤等直接停
        if ([429, 404, 500, 503].indexOf(e.status) >= 0 || (e.status === 400 && /model/i.test(e.message) && !/API key/i.test(e.message))) {
          progress('「' + model + '」無法使用（' + (e.status || '') + '），改用 ' + (models[i] || '…'));
          return next();
        }
        throw e;
      });
    };
    return Promise.resolve().then(next).catch(function (e) { throw new Error(friendly(provider, e)); });
  }
  function processGemini(audio) {
    var key = getS('geminiKey').trim();
    var mime = geminiMime(audio.blob, audio.name);
    var instr = window.TCM_GEMINI_AUDIO_INSTRUCTION(keyterms());
    step('stepUpload', 'active'); step('stepWrite', 'active');
    var partsP;
    if (audio.blob.size <= GEMINI_INLINE_MAX) {
      progress('上傳錄音並由 Gemini 同時產生逐字稿與病歷（' + (audio.blob.size / 1048576).toFixed(1) + ' MB，約需 30 秒～2 分鐘）…');
      partsP = blobToBase64(audio.blob).then(function (b64) { return [{ inlineData: { mimeType: mime, data: b64 } }, { text: instr }]; });
    } else {
      partsP = geminiUpload(key, audio.blob, mime, progress).then(function (f) {
        progress('Gemini 正在產生逐字稿與病歷…');
        return [{ fileData: { mimeType: f.mimeType || mime, fileUri: f.uri } }, { text: instr }];
      }).catch(function (e) { throw new Error(e.status ? friendly('gemini', e) : e.message); });
    }
    return partsP.then(function (parts) {
      return withFallback(geminiModels(), function (m) { return geminiGenerate(key, m, parts); }, 'gemini');
    }).then(function (res) {
      step('stepUpload', 'done'); step('stepWrite', 'done');
      return res;
    });
  }
  function recordFromTranscriptGemini(transcript) {
    var key = getS('geminiKey').trim();
    var parts = [{ text: '以下是今天門診的逐字稿（已標示說話者，可能有辨識錯誤）：\n\n"""\n' + transcript + '\n"""\n\n請依規則產生病歷草稿，以 JSON 回傳：transcript 原樣回傳空字串即可，record 放病歷。' }];
    return withFallback(geminiModels(), function (m) { return geminiGenerate(key, m, parts); }, 'gemini');
  }

  // ---------------- xAI（STT + Chat Completions） ----------------
  function xaiSTT(blob, name) {
    var key = getS('xaiKey').trim();
    var fd = new FormData();
    fd.append('model', XAI_STT_MODEL);
    var lang = getS('language');
    if (lang) { fd.append('language', lang); fd.append('format', 'true'); }
    fd.append('diarize', 'true');
    keyterms().forEach(function (t) { fd.append('keyterm', t); });
    fd.append('file', blob, name || ('audio.' + extFor(blob.type)));   // 官方要求 file 必須是最後一個欄位
    return fetchT(XAI_BASE + '/stt', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd })
      .then(function (r) { if (!r.ok) return readErr(r).then(function (e) { throw e; }); return r.json(); });
  }
  function isAsciiWord(s) { return /^[A-Za-z0-9][\w.\-'%]*$/.test(s); }
  function formatDiarized(res) {
    var words = res.words || [];
    if (!words.length) return String(res.text || '').trim();
    var hasSpk = words.some(function (w) { return typeof w.speaker === 'number'; });
    if (!hasSpk) return String(res.text || '').trim();
    var lines = [], cur = null, curText = '', prev = '', curStart = 0;
    words.forEach(function (w) {
      var spk = typeof w.speaker === 'number' ? w.speaker : (cur === null ? 0 : cur);
      var t = String(w.text || '');
      if (spk !== cur) {
        if (cur !== null && curText) lines.push('說話者' + (cur + 1) + '［' + fmt(curStart) + '］：' + curText.trim());
        cur = spk; curText = ''; prev = ''; curStart = w.start || 0;
      }
      curText += (prev && isAsciiWord(prev.slice(-1)) && isAsciiWord(t.charAt(0)) ? ' ' : '') + t;
      prev = t;
    });
    if (cur !== null && curText) lines.push('說話者' + (cur + 1) + '［' + fmt(curStart) + '］：' + curText.trim());
    return lines.join('\n');
  }
  function xaiChat(transcript) {
    var key = getS('xaiKey').trim();
    var models = [(getS('xaiModel') || '').trim() || XAI_DEFAULT_MODEL];
    XAI_FALLBACKS.forEach(function (m) { if (models.indexOf(m) < 0) models.push(m); });
    return withFallback(models, function (model) {
      return fetchT(XAI_BASE + '/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: model, temperature: 0.2, max_completion_tokens: 8000,
          messages: [
            { role: 'system', content: window.TCM_SYSTEM_PROMPT },
            { role: 'user', content: '以下是今天門診的語音辨識逐字稿（說話者編號為自動判斷，［mm:ss］為時間點）：\n\n"""\n' + transcript + '\n"""\n\n請依規則產生病歷草稿。' }
          ]
        })
      }).then(function (r) { if (!r.ok) return readErr(r).then(function (e) { throw e; }); return r.json(); })
        .then(function (j) {
          var t = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (!t) { var e = new Error('沒有回傳內容'); e.status = 0; throw e; }
          return { record: String(t), model: model };
        });
    }, 'xai');
  }
  // WAV 轉檔（xAI 不接受原格式時的備援）：解碼後重採樣成 16 kHz 單聲道 PCM16
  function toWav16k(blob) {
    return blob.arrayBuffer().then(function (buf) {
      var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      var ctx = new OAC(1, 16000, 16000);
      return new Promise(function (res, rej) { var p = ctx.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); });
    }).then(function (ab) {
      var n = ab.length, ch = ab.numberOfChannels, out = new Int16Array(n), datas = [];
      for (var c = 0; c < ch; c++) datas.push(ab.getChannelData(c));
      for (var i = 0; i < n; i++) { var s = 0; for (c = 0; c < ch; c++) s += datas[c][i]; s /= ch; s = Math.max(-1, Math.min(1, s)); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
      var sr = ab.sampleRate, hdr = new DataView(new ArrayBuffer(44)), w = function (o, str) { for (var k = 0; k < str.length; k++) hdr.setUint8(o + k, str.charCodeAt(k)); };
      w(0, 'RIFF'); hdr.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); hdr.setUint32(16, 16, true); hdr.setUint16(20, 1, true); hdr.setUint16(22, 1, true);
      hdr.setUint32(24, sr, true); hdr.setUint32(28, sr * 2, true); hdr.setUint16(32, 2, true); hdr.setUint16(34, 16, true); w(36, 'data'); hdr.setUint32(40, n * 2, true);
      return new Blob([hdr.buffer, out.buffer], { type: 'audio/wav' });
    });
  }
  function processXai(audio) {
    step('stepUpload', 'active');
    progress('上傳錄音到 xAI 語音辨識（' + (audio.blob.size / 1048576).toFixed(1) + ' MB）…');
    return xaiSTT(audio.blob, audio.name).catch(function (e) {
      if ((e.status === 400 || e.status === 415) && !/API key/i.test(e.message) && !/wav/i.test(audio.blob.type)) {
        progress('xAI 不接受此音檔格式，轉成 WAV 後重試…');
        return toWav16k(audio.blob).then(function (wav) { return xaiSTT(wav, 'audio.wav'); });
      }
      throw e;
    }).catch(function (e) { throw new Error(e.status ? friendly('xai', e) : e.message); })
      .then(function (res) {
        step('stepUpload', 'done');
        var transcript = formatDiarized(res);
        if (!transcript) throw new Error('辨識結果是空的（錄音可能太小聲或沒有對話）。');
        return toTraditional(transcript).then(function (t) {
          setTranscript(t);
          step('stepWrite', 'active'); progress('Grok 正在撰寫病歷…');
          return xaiChat(t).then(function (r) { step('stepWrite', 'done'); return { transcript: t, record: r.record, model: XAI_STT_MODEL + ' + ' + r.model }; });
        });
      });
  }

  // ---------------- 簡→繁（需要時才載入 OpenCC） ----------------
  var occ = null;
  function looksSimplified(t) { var m = String(t).match(/[这们说没时间问题还觉经颈脉针发头药么吗样怎请给对现医里边两个会热较帮红礼举乱饭睡梦觉汤颗处].?/g); return !!m && m.length >= 3; }
  function toTraditional(t) {
    if (getS('toTraditional') !== '1' || !looksSimplified(t)) return Promise.resolve(t);
    var load = occ ? Promise.resolve(occ) : new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = 'opencc-cn2t.js';
      s.onload = function () { try { occ = window.OpenCC.Converter({ from: 'cn', to: 'tw' }); res(occ); } catch (e) { rej(e); } };
      s.onerror = rej; document.head.appendChild(s);
    });
    return load.then(function (c) { return c(t); }).catch(function () { return t; });
  }

  // ---------------- 主流程 ----------------
  var busy = false;
  function setBusy(b) {
    busy = b;
    ['btnGenerate', 'btnSend', 'btnRetranscribe', 'btnClear'].forEach(function (id) { $(id).disabled = b; });
    $('btnStart').disabled = b || recording; $('fileInput').disabled = b || recording;
    if (!b) updateAudioButtons();
  }
  function checkSetup(needKey) {
    var p = getS('provider'), missing = [];
    if (needKey && p === 'gemini' && !getS('geminiKey')) missing.push('Gemini API 金鑰');
    if (needKey && p === 'xai' && !getS('xaiKey')) missing.push('xAI API 金鑰');
    if (missing.length) {
      $('settings').open = true; msg('setMsg', '請先填寫：' + missing.join('、') + '，再按「儲存設定」。', 'err');
      $('settings').scrollIntoView({ behavior: 'smooth' });
      return false;
    }
    return true;
  }
  function setTranscript(t) { $('transcript').value = t; sess.set('transcript', t); }
  function setRecord(t) { $('record').value = t; sess.set('record', t); }
  function cleanup(t) {
    return String(t || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s*/gm, '').replace(/\\n/g, '\n').trim();
  }

  function processAudio(audio) {
    if (!audio || !audio.blob || !audio.blob.size) { setStatus('error', '沒有錄音'); hint('沒有錄到聲音資料。', 'err'); return Promise.resolve(); }
    if (!checkSetup(true)) { setStatus('draft', '待設定'); hint('錄音已保存在手機。設定好金鑰後按「重新辨識錄音」。', 'warn'); return Promise.resolve(); }
    var provider = getS('provider');
    setBusy(true); setStatus('busy', '處理中'); msg('sendMsg', '');
    step('stepUpload'); step('stepWrite'); step('stepSend');
    var p = provider === 'xai' ? processXai(audio) : processGemini(audio);
    return p.then(function (res) {
      return toTraditional(res.transcript || '').then(function (t) {
        if (t) setTranscript(t);
        setRecord(cleanup(res.record));
        progress('完成（' + res.model + '）。請審閱後再使用。');
        setBusy(false);
        return autoSendIfEnabled();
      });
    }).catch(function (e) {
      setBusy(false); setStatus('error', '失敗');
      $('stepUpload').className.indexOf('done') < 0 ? step('stepUpload', 'fail') : step('stepWrite', 'fail');
      progress('❌ ' + e.message + '\n錄音仍保存在手機，可按「重新辨識錄音」重試，或「下載錄音檔」。');
      $('progressText').className = 'hint err';
    });
  }
  function regenerateFromTranscript() {
    var t = $('transcript').value.trim();
    if (!t) { msg('sendMsg', '逐字稿是空的。', 'err'); return; }
    if (!checkSetup(true)) return;
    setBusy(true); setStatus('busy', '撰寫中'); step('stepUpload', 'done'); step('stepWrite', 'active'); step('stepSend');
    progress('依目前逐字稿重新撰寫病歷…'); $('progressText').className = 'hint';
    var p = getS('provider') === 'xai' ? xaiChat(t) : recordFromTranscriptGemini(t);
    p.then(function (r) {
      setRecord(cleanup(r.record)); step('stepWrite', 'done'); progress('完成（' + r.model + '）。請審閱後再使用。');
      setBusy(false); return autoSendIfEnabled();
    }).catch(function (e) { setBusy(false); setStatus('error', '失敗'); step('stepWrite', 'fail'); progress('❌ ' + e.message); $('progressText').className = 'hint err'; });
  }
  function autoSendIfEnabled() {
    if (getS('autoSend') === '1' && getS('relayUrl') && getS('recipient')) return sendRelay(true);
    setStatus('draft', '草稿完成');
    if (!getS('recipient')) msg('sendMsg', '尚未設定收件信箱：請到「設定」填寫，或用「複製病歷」。', 'err');
    else if (!getS('relayUrl')) msg('sendMsg', '尚未設定寄信中繼：請按「用郵件 App 開啟」寄出，或「複製病歷」。');
  }

  // ---------------- 寄信 ----------------
  function isEmail(s) { return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s); }
  function mailParts() {
    var body = $('record').value.trim();
    var tr = $('transcript').value.trim();
    if (getS('attachTranscript') === '1' && tr) body += '\n\n————————\n【原始逐字稿（AI 辨識，未校正）】\n' + tr;
    body += '\n\n————————\n※ 本病歷為 AI 草稿，須經醫師審閱修改。';
    var subject = '中醫病歷 ' + taipeiStamp(new Date((currentAudio && currentAudio.startedAt) || Date.now()));
    return { to: getS('recipient'), subject: subject, body: body };
  }
  function sendRelay(auto) {
    var m = mailParts();
    if (!$('record').value.trim()) { msg('sendMsg', '病歷草稿是空的。', 'err'); return Promise.resolve(); }
    if (!m.to || !isEmail(m.to)) { $('settings').open = true; msg('sendMsg', '請先在「設定」填寫正確的收件信箱。', 'err'); setStatus('draft', '草稿完成'); return Promise.resolve(); }
    var url = getS('relayUrl');
    if (!url) { openMailto(); return Promise.resolve(); }
    setBusy(true); setStatus('busy', '寄送中'); step('stepSend', 'active');
    return postRelay(url, { token: getS('relayToken'), to: m.to, subject: m.subject, body: m.body }).then(function (r) {
      setBusy(false); setStatus('sent', '已寄出'); step('stepSend', 'done');
      msg('sendMsg', '✅ 已寄出到 ' + m.to + '（' + m.subject + '）', 'ok');
      if (getS('keepAudio') !== '1') { audioStore.clear().catch(function () {}); }
    }).catch(function (e) {
      setBusy(false); setStatus('error', '寄送失敗'); step('stepSend', 'fail');
      msg('sendMsg', '寄送失敗：' + e.message + '\n可改按「用郵件 App 開啟」或「複製病歷」。', 'err');
    });
  }
  function postRelay(url, payload) {
    // text/plain → 不觸發 CORS 預檢；Apps Script 會 302 轉到 googleusercontent（有 Access-Control-Allow-Origin: *）
    return fetchT(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' }, 60000)
      .then(function (r) { return r.text().then(function (t) { return { r: r, t: t }; }); })
      .then(function (x) {
        var j; try { j = JSON.parse(x.t); } catch (e) {
          throw new Error(/<html|<!DOCTYPE/i.test(x.t) ? '中繼網址回傳網頁而不是結果（請確認部署時「誰可以存取」選「所有人」，且網址結尾是 /exec）。' : ('中繼回應無法解析（HTTP ' + x.r.status + '）'));
        }
        if (!j.ok) throw new Error(j.error || '中繼回報失敗');
        return j;
      });
  }
  function openMailto() {
    var m = mailParts();
    if (!$('record').value.trim()) { msg('sendMsg', '病歷草稿是空的。', 'err'); return; }
    var href = 'mailto:' + encodeURIComponent(m.to || '') + '?subject=' + encodeURIComponent(m.subject) + '&body=' + encodeURIComponent(m.body.replace(/\n/g, '\r\n'));
    if (href.length > 60000) href = 'mailto:' + encodeURIComponent(m.to || '') + '?subject=' + encodeURIComponent(m.subject) + '&body=' + encodeURIComponent($('record').value.trim().replace(/\n/g, '\r\n'));
    window.location.href = href;
    setStatus('draft', '草稿完成');
    msg('sendMsg', '已開啟郵件 App，請在郵件 App 按「傳送」。' + (m.to ? '' : '（尚未設定收件信箱，請自行填寫）'));
  }
  function copyRecord() {
    var t = $('record').value; if (!t) { msg('sendMsg', '病歷草稿是空的。', 'err'); return; }
    var fallback = function () { $('record').focus(); $('record').select(); try { document.execCommand('copy'); msg('sendMsg', '已複製', 'ok'); } catch (e) { msg('sendMsg', '請手動全選複製', 'err'); } };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { msg('sendMsg', '✅ 已複製病歷到剪貼簿', 'ok'); }, fallback);
    else fallback();
  }

  // ---------------- 錄音檔按鈕 / 還原 ----------------
  var playerUrl = '';
  function updateAudioButtons() {
    var has = !!(currentAudio && currentAudio.blob && currentAudio.blob.size);
    $('btnRetranscribe').disabled = !has || busy || recording;
    $('btnDownloadAudio').disabled = !has;
    if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = ''; }
    if (has) { playerUrl = URL.createObjectURL(currentAudio.blob); $('player').src = playerUrl; $('player').hidden = false; }
    else { $('player').removeAttribute('src'); $('player').hidden = true; }
  }
  function downloadAudio() {
    if (!currentAudio) return;
    var a = document.createElement('a'); a.href = URL.createObjectURL(currentAudio.blob); a.download = currentAudio.name || 'visit.' + extFor(currentAudio.blob.type);
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function checkRecovery() {
    return audioStore.getMeta().then(function (m) {
      if (!m) return;
      return audioStore.getBlob(m.mime).then(function (blob) {
        if (!blob || !blob.size) return;
        currentAudio = { blob: blob, name: m.name || ('visit-' + m.startedAt + '.' + extFor(m.mime)), startedAt: m.startedAt, duration: m.duration };
        updateAudioButtons();
        var hasText = !!($('record').value.trim());
        if (m.status === 'recording') {
          $('recoverText').textContent = '⚠️ 發現一段中斷的錄音（' + taipeiStamp(new Date(m.startedAt)) + ' 開始，' + (blob.size / 1048576).toFixed(1) + ' MB）。頁面可能被重新整理或關閉，已錄到的部分仍保存在手機。';
          $('recoverBox').hidden = false;
          m.status = 'interrupted'; audioStore.setMeta(m).catch(function () {});
        } else if (!hasText) {
          $('recoverText').textContent = '上次的錄音（' + taipeiStamp(new Date(m.startedAt)) + '，' + (blob.size / 1048576).toFixed(1) + ' MB）還沒有產生病歷。';
          $('recoverBox').hidden = false;
        }
      });
    }).catch(function () {});
  }
  function clearSessionText() { setTranscript(''); setRecord(''); msg('sendMsg', ''); $('progress').hidden = true; $('progressText').className = 'hint'; }

  // ---------------- 設定 UI ----------------
  var FIELDS = ['recipient', 'geminiKey', 'geminiModel', 'xaiKey', 'xaiModel', 'relayUrl', 'relayToken', 'language', 'extraTerms', 'provider'];
  var CHECKS = ['autoSend', 'attachTranscript', 'toTraditional', 'keepAudio'];
  function loadSettingsUI() {
    FIELDS.forEach(function (k) { $(k).value = getS(k); });
    CHECKS.forEach(function (k) { $(k).checked = getS(k) === '1'; });
    providerUI();
  }
  function providerUI() {
    var p = $('provider').value;
    $('geminiBox').hidden = p !== 'gemini'; $('xaiBox').hidden = p !== 'xai';
    $('provName').textContent = p === 'xai' ? 'xAI' : 'Google Gemini';
  }
  function saveSettings() {
    var r = $('recipient').value.trim();
    if (r && !isEmail(r)) { msg('setMsg', '收件信箱格式不正確', 'err'); return false; }
    var u = $('relayUrl').value.trim();
    if (u && !/^https:\/\/script\.google(usercontent)?\.com\//.test(u)) { msg('setMsg', '中繼網址應以 https://script.google.com/ 開頭', 'err'); return false; }
    FIELDS.forEach(function (k) { setS(k, ($(k).value || '').trim()); });
    CHECKS.forEach(function (k) { setS(k, $(k).checked ? '1' : '0'); });
    msg('setMsg', '✅ 已儲存在這個瀏覽器', 'ok'); refreshWarn(); providerUI();
    return true;
  }
  function refreshWarn() {
    var p = getS('provider'), w = [];
    if (p === 'gemini' && !getS('geminiKey')) w.push('Gemini API 金鑰');
    if (p === 'xai' && !getS('xaiKey')) w.push('xAI API 金鑰');
    if (!getS('recipient')) w.push('收件信箱');
    $('setupWarn').hidden = !w.length;
    $('setupWarn').textContent = w.length ? '第一次使用：請到最下方「⚙️ 設定」填寫 ' + w.join('、') + '（只存在這支手機）。' : '';
  }

  // ---------------- 綁定 ----------------
  $('btnStart').onclick = startRecording;
  $('btnStop').onclick = function () { stopRecording().then(function (a) { if (a) return processAudio(a); }); };
  $('fileInput').onchange = function () {
    var f = this.files && this.files[0]; this.value = '';
    if (!f) return;
    if (currentAudio && !confirm('使用這個音檔會取代目前的錄音（及逐字稿、病歷），確定嗎？')) return;
    clearSessionText();
    currentAudio = { blob: f, name: f.name, startedAt: f.lastModified || Date.now() };
    audioStore.saveWhole(f, { id: String(Date.now()), mime: f.type, startedAt: currentAudio.startedAt, status: 'stopped', name: f.name, size: f.size }).catch(function () {});
    updateAudioButtons(); $('recoverBox').hidden = true;
    hint('已選擇音檔：' + f.name + '（' + (f.size / 1048576).toFixed(1) + ' MB）');
    processAudio(currentAudio);
  };
  $('btnRecoverUse').onclick = function () { $('recoverBox').hidden = true; processAudio(currentAudio); };
  $('btnRecoverDiscard').onclick = function () {
    if (!confirm('確定刪除這段錄音？')) return;
    audioStore.clear().catch(function () {}); currentAudio = null; updateAudioButtons(); $('recoverBox').hidden = true;
  };
  $('btnRetranscribe').onclick = function () { if (!busy && currentAudio) processAudio(currentAudio); };
  $('btnDownloadAudio').onclick = downloadAudio;
  $('btnGenerate').onclick = function () { if (!busy) regenerateFromTranscript(); };
  $('btnSend').onclick = function () { if (!busy) sendRelay(false); };
  $('btnMailto').onclick = openMailto;
  $('btnCopy').onclick = copyRecord;
  $('btnClear').onclick = function () {
    if (recording) return;
    if (!confirm('確定清除本次的錄音、逐字稿與病歷？（手機上的錄音也會刪除）')) return;
    clearSessionText(); audioStore.clear().catch(function () {}); currentAudio = null; updateAudioButtons();
    setStatus('', '待命'); $('timer').textContent = '00:00'; $('recoverBox').hidden = true; hint('已清除。');
  };
  $('transcript').addEventListener('input', function () { sess.set('transcript', this.value); });
  $('record').addEventListener('input', function () { sess.set('record', this.value); });
  $('provider').onchange = providerUI;
  Array.prototype.forEach.call(document.querySelectorAll('.showkey'), function (b) {
    b.onclick = function () { var i = $(b.getAttribute('data-for')); i.type = i.type === 'password' ? 'text' : 'password'; b.textContent = i.type === 'password' ? '顯示' : '隱藏'; };
  });
  $('btnSave').onclick = saveSettings;
  $('btnTestRelay').onclick = function () {
    if (!saveSettings()) return;
    if (!getS('relayUrl') || !getS('recipient')) { msg('setMsg', '請先填寫收件信箱與中繼網址。', 'err'); return; }
    msg('setMsg', '寄送測試信中…');
    postRelay(getS('relayUrl'), { token: getS('relayToken'), to: getS('recipient'), subject: '中醫 AI 病歷助手 測試信', body: '這是一封測試信。收到代表寄信中繼設定成功。\n' + taipeiStamp(new Date()) })
      .then(function () { msg('setMsg', '✅ 測試信已寄出到 ' + getS('recipient') + '，請到信箱確認。', 'ok'); })
      .catch(function (e) { msg('setMsg', '❌ ' + e.message, 'err'); });
  };
  $('btnForget').onclick = function () {
    if (!confirm('清除這個瀏覽器中的所有設定（含 API 金鑰）？')) return;
    Object.keys(DEFAULTS).forEach(function (k) { try { localStorage.removeItem(LS + k); } catch (e) {} });
    loadSettingsUI(); refreshWarn(); msg('setMsg', '已清除。', 'ok');
  };
  window.addEventListener('beforeunload', function (e) { if (recording) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('visibilitychange', function () {
    if (recording && document.visibilityState === 'visible' && navigator.wakeLock && !wakeLock) navigator.wakeLock.request('screen').then(function (w) { wakeLock = w; }).catch(function () {});
    if (document.visibilityState === 'visible') wakeLock = wakeLock && !wakeLock.released ? wakeLock : null;
  });

  // ---------------- 初始化 ----------------
  loadSettingsUI(); refreshWarn();
  setTranscript(sess.get('transcript')); setRecord(sess.get('record'));
  setStatus('', '待命');
  $('ver').textContent = '版本 ' + APP_VERSION;
  if (!getS('recipient') || !(getS('geminiKey') || getS('xaiKey'))) $('settings').open = true;
  checkRecovery();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () {});

  // 測試用（不影響正式使用）
  window.__tcm = { formatDiarized: formatDiarized, geminiMime: geminiMime, keyterms: keyterms, pickMime: pickMime, looksSimplified: looksSimplified, mailParts: mailParts, version: APP_VERSION };
})();
