#!/bin/sh
# Builds the hosted, password-gated app into ./web
set -e
STAMP=$(date +%Y%m%d%H%M%S)
mkdir -p web/lib

# 1. the app HTML, with the full recovered state (photo included) seeded in
node - <<'NODE'
const fs = require('fs');
const board = fs.readFileSync('board.html', 'utf8');
/* my-board.json (gitignored) is an optional export of your board to start from; without it the app opens on the setup wizard */
const full = fs.existsSync('my-board.json') ? fs.readFileSync('my-board.json', 'utf8').trim() : 'null';
const MARK = /(\/\* Recovered from the 3 Sep session[\s\S]*?\n  var SEED = )[\s\S]*?(;\n)/;
if (!MARK.test(board)) { console.error('SEED marker not found'); process.exit(1); }
const seeded = board.replace(MARK, (_m, a, b) => a + full + b);
fs.writeFileSync('/tmp/warplan-seeded.html', seeded);
console.log('seeded ' + Math.round(seeded.length/1024) + 'KB');
NODE

# 2. wrap it as a full document with the PWA head
{
  printf '<!doctype html>\n<html lang="en">\n<head>\n'
  printf '<meta charset="utf-8">\n'
  printf '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
  printf '<meta name="theme-color" content="#000321">\n'
  printf '<meta name="robots" content="noindex,nofollow">\n'
  printf '<link rel="manifest" href="/manifest.webmanifest">\n'
  printf '<link rel="icon" href="/icons/icon-32.png" sizes="32x32">\n'
  printf '<link rel="apple-touch-icon" href="/icons/icon-180.png">\n'
  printf '<meta name="apple-mobile-web-app-capable" content="yes">\n'
  printf '<meta name="mobile-web-app-capable" content="yes">\n'
  printf '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n'
  printf '<meta name="apple-mobile-web-app-title" content="Warplan">\n'
  printf '<style>html{color-scheme:light}body{margin:0;font:14px system-ui}img{max-width:100%%}[hidden]{display:none!important}</style>\n'
  cat /tmp/warplan-seeded.html
  printf '\n<script>if("serviceWorker" in navigator){window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){});});}</script>\n'
  printf '</body>\n</html>\n'
} > /tmp/warplan-full.html

# 3. ship it to the function as base64, so no escaping can corrupt it
node -e "
const fs=require('fs');
const b64=fs.readFileSync('/tmp/warplan-full.html').toString('base64');
fs.writeFileSync('web/lib/page.js','module.exports={HTML_B64:'+JSON.stringify(b64)+'};\n');
console.log('page module '+Math.round(b64.length/1024)+'KB');
"
rm -f /tmp/warplan-seeded.html /tmp/warplan-full.html

# 4. manifest + service worker
cat > web/manifest.webmanifest <<JSON
{
  "name": "Warplan",
  "short_name": "Warplan",
  "description": "The year, the goals, and the daily loop that produces them.",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait-primary",
  "background_color": "#fcfcfa",
  "theme_color": "#000321",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
JSON

cat > web/sw.js <<JS
const VERSION = 'warplan-$STAMP';
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
JS

echo "web built ($STAMP)"
