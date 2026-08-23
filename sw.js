const VERSION = 'xcoder-v5.0.0';
const APP_CACHE = `${VERSION}-app`;
const SHELL = [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/icon-source-1024.png',
  './v5.css', './v5.js'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(APP_CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if ((key.startsWith('arena-pocket-ide-') || key.startsWith('xcoder-')) && key !== APP_CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function networkOrCache(req){
  try {
    const fresh = await fetch(req);
    if (fresh.ok) (await caches.open(APP_CACHE)).put(req, fresh.clone());
    return fresh;
  } catch {
    return (await caches.match(req)) || null;
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const fresh = await networkOrCache(req);
      return fresh || (await caches.match('./index.html')) || new Response('Offline', { status: 503 });
    })());
    return;
  }

  // Progressive v5 layering: an older v4.9 index.html that only loads app.js/styles.css
  // receives the new AI voice/model/Git enhancements after this service worker activates.
  if (url.pathname.endsWith('/app.js')) {
    event.respondWith((async () => {
      const base = await networkOrCache(req);
      const extra = await networkOrCache(new Request(new URL('./v5.js', self.registration.scope), {cache:'no-cache'}));
      if (!base) return new Response('Offline', {status:503,headers:{'content-type':'text/javascript'}});
      if (!extra) return base;
      return new Response(`${await base.text()}\n\n/* X Coder v5 progressive enhancements */\n${await extra.text()}`, {
        status:200, headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'no-cache'}
      });
    })());
    return;
  }

  if (url.pathname.endsWith('/styles.css')) {
    event.respondWith((async () => {
      const base = await networkOrCache(req);
      const extra = await networkOrCache(new Request(new URL('./v5.css', self.registration.scope), {cache:'no-cache'}));
      if (!base) return new Response('Offline', {status:503,headers:{'content-type':'text/css'}});
      if (!extra) return base;
      return new Response(`${await base.text()}\n\n/* X Coder v5 styles */\n${await extra.text()}`, {
        status:200, headers:{'content-type':'text/css; charset=utf-8','cache-control':'no-cache'}
      });
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    const fresh = await networkOrCache(req);
    return fresh || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
  })());
});
