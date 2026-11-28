const CACHE = 'cm-websocket-monitor-shell-v1'
const SHELL = [
  './',
  './index.html',
  './offline.html',
  './manifest.webmanifest',
  './icon.svg',
  './assets/css/styles.css',
  './assets/js/app.js',
  './assets/js/freshness.js',
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return

  const url = new URL(request.url)
  // Never serve cached status, uptime, incident or maintenance data as current.
  if (url.pathname.includes('/data/') || url.pathname.includes('/badges/') || url.pathname.endsWith('/maintenance.json')) {
    event.respondWith(fetch(request, { cache: 'no-store' }))
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await caches.match('./offline.html')) || Response.error()))
    return
  }

  // Revalidate static assets on every visit; fall back to the previous shell only offline.
  event.respondWith(fetch(request, { cache: 'no-store' }).then((response) => {
    if (response.ok && response.type === 'basic') {
      const copy = response.clone()
      caches.open(CACHE).then((cache) => cache.put(request, copy))
    }
    return response
  }).catch(async () => (await caches.match(request)) || Response.error()))
})
