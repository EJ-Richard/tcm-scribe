/**
 * 中醫 AI 病歷助手 — 寄信中繼（Google Apps Script）
 * 每位醫師各自部署一份，用「自己的 Gmail」寄出病歷。本程式不儲存任何病歷內容。
 *
 * 部署步驟（詳見 安裝說明.md）：
 *  1. 到 https://script.google.com 新增專案，把這整份貼進 Code.gs（取代原內容），儲存。
 *  2. 修改下方 RELAY_TOKEN 為您自己的一串密碼（至少 12 字，英數混合）。
 *  3. 選函式 testRelay → 執行 → 依指示授權（會寄一封測試信給您自己）。
 *  4. 部署 > 新增部署作業 > 類型「網頁應用程式」
 *       執行身分：我（Me）
 *       誰可以存取：所有人（Anyone）
 *     → 複製結尾為 /exec 的網址，貼到病歷助手的「設定 > 寄信中繼網址」，密碼貼到「中繼密碼」。
 *
 * 安全：沒有正確密碼的請求一律拒絕；可再用 ALLOWED_RECIPIENTS 限定只能寄到自己的信箱。
 */

var RELAY_TOKEN = '請改成您自己的密碼';
// 選填：限定只能寄到這些信箱（小寫）。留空陣列 [] = 不限制。建議填您自己的收件信箱。
var ALLOWED_RECIPIENTS = [];
var SENDER_NAME = '中醫 AI 病歷助手';
var MAX_BODY_CHARS = 100000;

function doPost(e) {
  try {
    var data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!RELAY_TOKEN || RELAY_TOKEN === '請改成您自己的密碼') return json_({ ok: false, error: '中繼尚未設定 RELAY_TOKEN（請修改 mail_relay.gs 後重新部署）' });
    if (String(data.token || '') !== RELAY_TOKEN) return json_({ ok: false, error: '中繼密碼錯誤' });

    var to = String(data.to || '').trim().toLowerCase();
    if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to)) return json_({ ok: false, error: '收件信箱格式不正確' });
    if (ALLOWED_RECIPIENTS.length && ALLOWED_RECIPIENTS.indexOf(to) === -1) return json_({ ok: false, error: '此收件信箱不在中繼允許清單中' });

    var subject = String(data.subject || '').slice(0, 200) ||
      ('中醫病歷 ' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd HH:mm'));
    var body = String(data.body || '');
    if (!body.trim()) return json_({ ok: false, error: '信件內容是空的' });
    if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS) + '\n…（內容過長已截斷）';

    if (MailApp.getRemainingDailyQuota() < 1) return json_({ ok: false, error: '今天的 Gmail 寄信額度已用完' });
    MailApp.sendEmail({ to: to, subject: subject, body: body, name: SENDER_NAME });
    return json_({ ok: true, to: to, subject: subject, sentAt: Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd HH:mm:ss') });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/** 用瀏覽器直接打開 /exec 網址時顯示（確認部署成功用）。 */
function doGet() {
  return json_({ ok: true, service: 'tcm-scribe mail relay', ready: RELAY_TOKEN !== '請改成您自己的密碼' });
}

/** 在編輯器手動執行一次：完成授權，並寄一封測試信給自己。 */
function testRelay() {
  var me = Session.getActiveUser().getEmail();
  MailApp.sendEmail({ to: me, subject: '寄信中繼測試', body: '授權成功。今日剩餘寄信額度：' + MailApp.getRemainingDailyQuota(), name: SENDER_NAME });
  Logger.log('已寄測試信到 ' + me + '；RELAY_TOKEN 已設定：' + (RELAY_TOKEN !== '請改成您自己的密碼'));
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
