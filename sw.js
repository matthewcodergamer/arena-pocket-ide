const VERSION = 'xcoder-v5.1.0';
const APP_CACHE = `${VERSION}-app`;
const SHELL = [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/icon-source-1024.png',
  './v5.css', './v5.js', './v51.css', './v51.js'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(APP_CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if ((key.startsWith('arena-pocket-ide-') || key.startsWith('xcoder-')) && key !== APP_CACHE) await caches.delete(key);
    }
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

async function layeredResponse(req, extras, type){
  const base = await networkOrCache(req);
  if (!base) return new Response('Offline', {status:503, headers:{'content-type':type}});
  let text = await base.text();
  for (const path of extras) {
    const extra = await networkOrCache(new Request(new URL(path, self.registration.scope), {cache:'no-cache'}));
    if (extra) text += `\n\n/* X Coder layer: ${path} */\n${await extra.text()}`;
  }
  return new Response(text, {
    status:200,
    headers:{'content-type':`${type}; charset=utf-8`, 'cache-control':'no-cache'}
  });
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

  // Keep the stable core while progressively layering the current presentation/runtime enhancements.
  if (url.pathname.endsWith('/app.js')) {
    event.respondWith(layeredResponse(req, ['./v5.js', './v51.js'], 'text/javascript'));
    return;
  }

  if (url.pathname.endsWith('/styles.css')) {
    event.respondWith(layeredResponse(req, ['./v5.css', './v51.css'], 'text/css'));
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    const fresh = await networkOrCache(req);
    return fresh || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
  })());
});
