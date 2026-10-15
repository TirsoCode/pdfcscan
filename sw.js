/**
 * sw.js — Caché offline de la app.
 *
 * Todo el trabajo ocurre en el cliente, así que guardar el armazón basta
 * para que la herramienta siga funcionando sin conexión.
 */

const CACHE = 'fotoapdf-v2';
const ASSETS = ['./', './index.html', './styles.css', './icon.svg',
  './js/app.js', './js/pdf.js', './js/detect.js',
  './js/imageops.js', './js/cropper.js', './js/camera.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      // solo guardamos lo que venga completo y del mismo origen
      if (res.ok && new URL(e.request.url).origin === self.location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match('./index.html'))),
  );
});