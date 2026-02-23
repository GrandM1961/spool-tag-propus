const CACHE_NAME = 'spool-propus-v1.6.109';
const ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/auth.js',
  '/i18n.js',
  '/color.js',
  '/cbor.js',
  '/ndef.js',
  '/formats.js',
  '/openspool.js',
  '/openprinttag.js',
  '/filamentdb.js',
  '/profiledb.js',
  '/drying.js',
  '/qr.js',
  '/manifest.json',
  '/logo.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // For JS/CSS/HTML files: always try network first, ignore query params for cache key
  const isAsset = /\.(js|css|html)(\?.*)?$/.test(url.pathname) || url.pathname === '/';
  if (isAsset) {
    // Network-first: always fetch fresh, update cache
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            // Cache using pathname only (without query string) as key
            const cacheKey = new Request(url.origin + url.pathname);
            caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, clone));
          }
          return resp;
        })
        .catch(() => {
          const cacheKey = new Request(url.origin + url.pathname);
          return caches.match(cacheKey);
        })
    );
    return;
  }

  // Other assets: stale-while-revalidate
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return resp;
      });
      return cached || fetchPromise;
    })
  );
});
