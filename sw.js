/* 網路優先、離線時用快取：讓「已開過的頁面」在沒網路時也能打開錄音 */
var CACHE = 'tcm-scribe2-v2.0.0';
var ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'prompt.js', 'manifest.webmanifest', 'icon-192.png', 'apple-touch-icon.png'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return;   // API 呼叫一律不經過快取
  e.respondWith(fetch(e.request).then(function (r) {
    if (r && r.ok) { var c = r.clone(); caches.open(CACHE).then(function (ca) { ca.put(e.request, c); }); }
    return r;
  }).catch(function () { return caches.match(e.request, { ignoreSearch: true }); }));
});
