// sw.js — App Shell 缓存（在线使用；市场 API/SSE 不缓存）
const CACHE = 'mcard-shell-v1';
const SHELL = [
  '/',
  '/app.css',
  '/app.js',
  '/dispatch.js',
  '/shared.js',
  '/theme-bootstrap.js',
  '/lang-bootstrap.js',
  '/dropStats.js',
  '/marketStats.js',
  '/portrait.js',
  '/logo.png',
  '/manifest.webmanifest',
  '/locales/zh.js',
  '/locales/en.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API + SSE：不缓存（在线使用，市场数据始终走网络）
  if (url.pathname.startsWith('/api/') || url.pathname === '/events') return;
  // App Shell：网络优先，离线回退缓存
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((cached) => cached || new Response('offline', { status: 503 })))
  );
});
