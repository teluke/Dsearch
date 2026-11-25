/* Service Worker：应用壳缓存，离线可用 */

const CACHE = 'gongzuowenjian-v44';

/* js/css 经常随版本更新，走网络优先，避免两端版本不一致导致同步配对失败；
   离线时回退到缓存，离线可用性不受影响 */
const NET_FIRST = /\/(js|css)\//;

const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/db.js',
  './js/parser.js',
  './js/ocr.js',
  './js/ocr-job.js',
  './js/keywords.js',
  './js/events.js',
  './js/ui.js',
  './js/backup.js',
  './js/viewer.js',
  './js/sync.js',
  './js/views.js',
  './js/sync-ui.js',
  './js/app.js',
  './vendor/dexie.min.js',
  './vendor/jszip.min.js',
  './vendor/mammoth.browser.min.js',
  './vendor/xlsx.full.min.js',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
  './vendor/qrcode.min.js',
  './vendor/jsqr.min.js',
  './vendor/tesseract/tesseract.min.js',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/fonts/ui-handwriting-subset.woff2'
];

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map(function (url) {
      return cache.add(new Request(url, { cache: 'reload' })).catch(function () { /* 单个失败不阻断 */ });
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) {
      return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith((async function () {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('./index.html', fresh.clone()).catch(function () {});
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE);
        const cached = await cache.match('./index.html') || await cache.match('./');
        if (cached) return cached;
        return new Response('离线状态下无法打开，请联网后重试。', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }

  if (NET_FIRST.test(url.pathname)) {
    event.respondWith((async function () {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.status === 200) {
          const cache = await caches.open(CACHE);
          cache.put(req, fresh.clone()).catch(function () {});
          return fresh;
        }
      } catch (e) { /* 离线，走缓存 */ }
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      return new Response('', { status: 504 });
    })());
    return;
  }

  event.respondWith((async function () {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.status === 200) {
        cache.put(req, fresh.clone()).catch(function () {});
      }
      return fresh;
    } catch (e) {
      return new Response('', { status: 504 });
    }
  })());
});
