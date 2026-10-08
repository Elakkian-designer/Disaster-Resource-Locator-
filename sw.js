// ResqMap Service Worker
const VERSION = 'v1';
const CORE_CACHE = `resqmap-core-${VERSION}`;
const RUNTIME_CACHE = `resqmap-runtime-${VERSION}`;
const TILE_CACHE = `resqmap-tiles-${VERSION}`;
const MAX_TILES = 400;

const CORE_FILES = ['./', './index.html'];
const CDN_FILES = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-solid-900.woff2'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const core = await caches.open(CORE_CACHE);
    await Promise.allSettled(CORE_FILES.map(f => core.add(f)));
    const rt = await caches.open(RUNTIME_CACHE);
    // CDN files are cross-origin: fetch as no-cors (opaque) so one failure doesn't break install
    await Promise.allSettled(CDN_FILES.map(async url => {
      const res = await fetch(new Request(url, { mode: 'no-cors' }));
      await rt.put(url, res);
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = [CORE_CACHE, RUNTIME_CACHE, TILE_CACHE];
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !keep.includes(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length > max) {
    await Promise.all(keys.slice(0, keys.length - max).map(k => cache.delete(k)));
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 1) Page navigations: network first, fall back to cached app shell
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CORE_CACHE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('./index.html')) || (await caches.match('./'));
      }
    })());
    return;
  }

  // 2) Map tiles: cache first, then network (so visited areas work offline)
  if (url.hostname.includes('arcgisonline.com')) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) {
          cache.put(req, res.clone());
          trimCache(TILE_CACHE, MAX_TILES);
        }
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // 3) Everything else (own files + CDN libs): stale-while-revalidate
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then(async res => {
      if (res && (res.ok || res.type === 'opaque')) {
        const cache = await caches.open(url.origin === location.origin ? CORE_CACHE : RUNTIME_CACHE);
        cache.put(req, res.clone());
      }
      return res;
    }).catch(() => null);
    return cached || (await network) || new Response('', { status: 504 });
  })());
});
