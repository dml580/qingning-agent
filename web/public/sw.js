const CACHE_NAME = 'qingning-shell-v3'
const APP_SHELL = ['/', '/manifest.webmanifest', '/favicon.png', '/logo.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key.startsWith('qingning-shell-') && key !== CACHE_NAME) return caches.delete(key)
          return Promise.resolve(false)
        }),
      ),
    ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  if (request.url.includes('/api/')) return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/src/') || url.pathname.startsWith('/@') || url.pathname.startsWith('/node_modules/') || url.pathname === '/sw.js') return

  if (request.mode === 'navigate') {
    // HTML 网络优先，避免新版发布后长期卡在旧页面。
    event.respondWith(
      fetch(request).then((response) => {
        if (response.ok) {
          const cloned = response.clone()
          void caches.open(CACHE_NAME).then((cache) => cache.put('/', cloned))
        }
        return response
      }).catch(() => caches.match('/')),
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request)
        .then((response) => {
          const cloned = response.clone()
          if (response.ok) void caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned))
          return response
        })
        .catch(() => caches.match('/'))
    }),
  )
})
