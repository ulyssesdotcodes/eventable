// Offline service worker. Precaches the app shell on install, then serves
// same-origin GETs cache-first, so an open paints the last-known-good build
// immediately — online or off — instead of waiting on a mobile network that
// may be slow, flaky, or answering from a stale HTTP cache.
//
// Freshness rides the worker update check instead of the request path: VERSION
// is stamped in at build time (scripts/stamp-sw.js) from a hash of everything
// in the build, so a new deploy is a new script, which installs the new files
// into a new cache before taking over. src/main.ts asks for that check in the
// background and reloads the page once the new worker is in control.
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
  // Never awaited inside waitUntil: skipWaiting() only settles once this worker
  // activates, activation waits on install, and install would be waiting on
  // skipWaiting() — a deadlock that leaves an update wedged mid-install and
  // blocks every later update check on this scope. A first install has no
  // waiting phase and slips through, which is what made the app install fine
  // and then never update.
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
    // Taking control is what tells the open pages to reload onto this build.
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

// A hit is never stale for the running page: CACHE is version-keyed, so it
// holds exactly one build, and a changed file arrives as a new worker with a
// new cache rather than as a revalidation of this one.
async function cacheFirst(req) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(req)
  if (cached) return cached
  const res = await fetch(req)
  if (res.ok) await cache.put(req, res.clone())
  return res
}
