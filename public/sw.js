// Offline support: the app and its reference data are cached after the
// first visit, so the tool keeps working with no connection.
const CACHE = 'map-stylizer-v2';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', 'manifest.webmanifest', 'data/ne-medium.topojson'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  // Built files have hashed names and data files rarely change: cache first.
  if (sameOrigin && (url.pathname.includes('/assets/') || url.pathname.includes('/data/') || url.pathname.includes('/icons/'))) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })));
    return;
  }
  // Pages and map fonts: network first so updates arrive, cache when offline.
  if (sameOrigin || url.hostname === 'demotiles.maplibre.org') {
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; }).catch(() => caches.match(req)));
  }
});
