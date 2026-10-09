/*
 * SnapClean service worker.
 * - Caches the app shell so the installed app works offline.
 * - Receives images shared from other Android apps (Web Share Target) and
 *   hands them to the page via a temporary cache entry.
 */
var VERSION = 'snapclean-v3';
var SHARE_CACHE = 'snapclean-share';
var SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/core.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-192.png',
  'icons/maskable-512.png',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(VERSION).then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== VERSION && k !== SHARE_CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET') return;

  // Network first so updates show up straight away; cache when offline.
  event.respondWith(
    fetch(req).then(function (res) {
      if (res.ok) {
        var copy = res.clone();
        caches.open(VERSION).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        return hit || caches.match('index.html');
      });
    })
  );
});

function receiveShare(req) {
  var appUrl = new URL('./', self.location.href);
  return req.formData().then(function (form) {
    var file = form.get('image');
    if (!file || typeof file === 'string') return Response.redirect(appUrl.href, 303);
    return caches.open(SHARE_CACHE).then(function (cache) {
      return cache.put('shared-image', new Response(file, {
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name || 'image'),
        },
      }));
    }).then(function () {
      return Response.redirect(appUrl.href + '?shared=1', 303);
    });
  }).catch(function () {
    return Response.redirect(appUrl.href, 303);
  });
}
