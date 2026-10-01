const VERSION = 'warplan-20261001143706';
const SHELL = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-180.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).pathname.startsWith('/api/')) return;   // live data, never cached
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(r => {
        // only ever cache the real app, never the login screen
        if (r.ok && r.headers.get('X-Warplan') === 'app') {
          const copy = r.clone();
          caches.open(VERSION).then(c => c.put('/', copy));
        }
        return r;
      }).catch(() => caches.match('/'))
    );
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return r;
  }).catch(() => hit)));
});
