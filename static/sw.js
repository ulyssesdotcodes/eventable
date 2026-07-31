// Offline service worker. Precaches the app shell on install, then serves
// same-origin GETs cache-first, so an open paints the last-known-good build
// immediately rather than waiting on a mobile network. Freshness rides the
// worker update check instead of the request path: VERSION is stamped in at
// build time (scripts/stamp-sw.js) from a hash of the whole build, so a deploy
// is a new script, which caches the new files before taking over — src/main.ts
// runs that check in the background and reloads once it does.
const VERSION = '__BUILD_VERSION__'
const CACHE = `eventable-${VERSION}`

// The minimum needed to boot offline. lang-worker.js (~3.5 MB) and the data
// files are left to runtime caching so a flaky install can't abort on them; the
// editor loads its language service lazily and still runs without it.
const SHELL = [
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
  // Never awaited inside waitUntil: skipWaiting() settles only once this worker
  // activates, which waits on install — a deadlock that wedges the update and
  // blocks every later check on this scope. A first install has no waiting
  // phase and slips through, which is why it broke updates and not installs.
  void self.skipWaiting()
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

  // Leave cross-origin requests alone — the WebSocket upgrade at /ws is never a
  // GET fetch, so multiplayer is unaffected.
  if (new URL(req.url).origin !== self.location.origin) return

  // Every navigation resolves to the one cached shell: index.html covers any
  // ?room=/?example= route.
  event.respondWith(cacheFirst(req.mode === 'navigate' ? '/index.html' : req))
})

// A hit is never stale: CACHE is version-keyed, so a changed file arrives as a
// new worker with a new cache rather than as a revalidation of this one.
async function cacheFirst(req) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(req)
  if (cached) return cached
  const res = await fetch(req)
  if (res.ok) await cache.put(req, res.clone())
  return res
}
