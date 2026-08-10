/* PuttLab Pro service worker. Cache-first shell so the analyser opens on a
   practice green with no signal. The demo clip is deliberately NOT precached
   — it is 140 KB of fixture, not part of the tool. */
const CACHE = 'puttlab-pro-v2';
const SHELL = ['./', './index.html', './manifest.json',
  './src/app.js', './src/mp4.js', './src/decoder.js', './src/geom.js',
  './src/detect.js', './src/track.js', './src/analyse.js', './src/charts.js',
  './src/timeline.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'];

self.addEventListener('install', e => e.waitUntil(
  caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting())));

self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;
  e.respondWith(caches.match(req).then(hit => {
    if (hit) {
      fetch(req).then(r => { if (r && r.ok) caches.open(CACHE).then(c => c.put(req, r.clone())); }).catch(() => {});
      return hit;
    }
    return fetch(req).then(r => {
      if (r && r.ok) { const cl = r.clone(); caches.open(CACHE).then(c => c.put(req, cl)); }
      return r;
    }).catch(() => caches.match('./index.html'));
  }));
});
