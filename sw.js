/* Service worker: makes Sustain installable and usable without a connection.

   Network-first, not cache-first. A cache-first worker would keep serving an
   old copy of the app after a deploy, which is the classic way installed web
   apps get stuck on stale code. This asks the network first, updates the
   cache from the response, and only falls back to the cache when offline.

   The evening and morning check-ins, the journal, the chart and export all
   work with no connection, because the data lives in localStorage. Only the
   Insights call needs the network, and it is never cached. */

var CACHE = 'sustain-v1';
var SHELL = ['/', '/index.html', '/icon.png', '/manifest.webmanifest'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .catch(function () { /* a missing file must not block installation */ })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                  // the POST to /api/insights passes straight through

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;   // never cache the analysis endpoint

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || caches.match('/index.html');
      });
    })
  );
});
