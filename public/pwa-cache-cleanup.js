const precachePrefix = "workbox-precache"

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(cacheNames => Promise.all(
      cacheNames
        .filter(cacheName => !cacheName.startsWith(precachePrefix))
        .map(cacheName => caches.delete(cacheName)),
    )),
  )
})
