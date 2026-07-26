// Offline service worker. Precaches the app shell on install so a reload with
// no network still boots, then serves same-origin requests network-first (fresh
// when online, cached when offline). The version below is stamped in at build
// time (build.js / watch.js) so each deploy activates a fresh cache and evicts
// the previous one.
const VERSION = '__BUILD_VERSION__'
const CACHE = `eventable-${VERSION}`

// The minimum needed to boot offline. lang-worker.js (~3.5 MB) and the data
// files are left to runtime caching so a flaky install can't abort on them; the
// editor loads its language service lazily and still runs without it.
const SHELL = [
  '/',
  '/index.html',
  '/assets/index.js',
  '/assets/index.css',
  '/assets/cook-worker.js',
  '/assets/feather.min.js',
  '/assets/lang-env.json',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    // Cache each shell entry tolerantly: one unreachable asset must not fail the
    // whole install and leave us with no offline shell.
    await Promise.all(SHELL.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' })
        if (res.ok) await cache.put(url, res)
      } catch { /* runtime caching picks it up on first real request */ }
    }))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE && key.startsWith('eventable-')) await caches.delete(key)
    }
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  // Leave cross-origin requests alone — the WebSocket upgrade at /ws is never a
  // GET fetch, so multiplayer is unaffected.
  if (url.origin !== self.location.origin) return

  // Navigations: network-first, falling back to the cached shell so a reload
  // works offline. The cached index.html covers any ?room=/?example= route.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, '/index.html'))
    return
  }

  // Same-origin assets and data: network-first so an online reload always gets
  // the latest build; the cache fallback keeps them available offline.
  event.respondWith(networkFirst(req))
})

async function networkFirst(req, fallbackUrl) {
  const cache = await caches.open(CACHE)
  try {
    const res = await fetch(req)
    if (res.ok) await cache.put(req, res.clone())
    return res
  } catch (err) {
    const cached = await caches.match(req)
    if (cached) return cached
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl)
      if (fallback) return fallback
    }
    throw err
  }
}
