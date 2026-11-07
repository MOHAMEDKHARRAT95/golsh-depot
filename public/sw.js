// Service worker : l'application s'ouvre instantanément et reste affichable sans réseau.
const VERSION = 'golsh-v2';
const SHELL = ['/', '/index.html', '/style.css?v=2', '/app.js?v=2', '/vendor/qrcode.js?v=2', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return; // données : toujours en direct
  if (url.origin !== location.origin) {
    // bibliothèque du scanner (CDN) : mise en cache après le premier chargement
    e.respondWith(caches.open(VERSION).then(async (c) => (await c.match(req)) || fetch(req).then((r) => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; })));
    return;
  }
  // fichiers de l'application : réseau d'abord, cache en secours
  e.respondWith(
    fetch(req)
      .then((r) => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return r; })
      .catch(async () => (await caches.match(req)) || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error()))
  );
});
