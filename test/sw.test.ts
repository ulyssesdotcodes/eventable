import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stampServiceWorker } from '../scripts/stamp-sw.js'

const ORIGIN = 'https://app.test'
const source = readFileSync(new URL('../static/sw.js', import.meta.url), 'utf8')

// static/sw.js is plain worker script — run it against a fake global rather
// than a real browser, so the caching contract is testable in `npm test`.
function loadWorker(files: Record<string, string>) {
  const caches = new Map<string, Map<string, Response>>()
  const requested: string[] = []
  const handlers = new Map<string, (event: unknown) => void>()
  const network = { online: true }
  const key = (req: string | Request) => new URL(typeof req === 'string' ? req : req.url, ORIGIN).href

  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, fn),
    location: { origin: ORIGIN },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  }
  const cacheStorage = {
    open: async (name: string) => {
      if (!caches.has(name)) caches.set(name, new Map())
      const entries = caches.get(name)!
      return {
        match: async (req: string | Request) => entries.get(key(req))?.clone(),
        put: async (req: string | Request, res: Response) => { entries.set(key(req), res) },
      }
    },
    keys: async () => [...caches.keys()],
    delete: async (name: string) => caches.delete(name),
  }
  const fetchImpl = async (req: string | Request) => {
    const url = key(req)
    requested.push(url)
    const body = files[new URL(url).pathname]
    if (!network.online || body === undefined) throw new Error(`unreachable: ${url}`)
    return new Response(body)
  }

  new Function('self', 'caches', 'fetch', source.replaceAll('__BUILD_VERSION__', 'test'))(self, cacheStorage, fetchImpl)

  const run = async (type: string, event: Record<string, unknown>) => {
    let pending: Promise<unknown> | undefined
    handlers.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => { pending = p }, respondWith: (p: Promise<unknown>) => { pending = p } })
    return await pending
  }
  return {
    caches,
    network,
    requested,
    install: () => run('install', {}),
    activate: () => run('activate', {}),
    // Returns undefined when the worker declined to handle the request (it
    // never called respondWith), which means the browser goes to the network.
    request: (url: string, mode = 'no-cors', method = 'GET') =>
      run('fetch', { request: { url: new URL(url, ORIGIN).href, mode, method } }) as Promise<Response | undefined>,
  }
}

const SHELL_FILES = {
  '/index.html': 'shell v1',
  '/assets/index.js': 'bundle v1',
  '/assets/index.css': 'css v1',
  '/assets/cook-worker.js': 'cook v1',
  '/assets/feather.min.js': 'feather v1',
  '/assets/lang-env.json': '{}',
  '/manifest.webmanifest': '{}',
  '/icons/icon-192.png': 'png',
  '/icons/icon-512.png': 'png',
}

test('an open is served from cache without the network, and any route falls back to the shell', async () => {
  const sw = loadWorker(SHELL_FILES)
  await sw.install()

  // The whole point of cache-first: a warm open paints without waiting on a
  // mobile network that may be slow or answering from a stale HTTP cache.
  sw.network.online = false
  sw.requested.length = 0
  assert.equal(await (await sw.request('/?room=jam', 'navigate'))!.text(), 'shell v1')
  assert.equal(await (await sw.request('/assets/index.js'))!.text(), 'bundle v1')
  assert.deepEqual(sw.requested, [], 'served entirely from cache')
})

test('a request outside the shell falls through to the network and is cached for next time', async () => {
  const sw = loadWorker({ ...SHELL_FILES, '/data/co2.csv': 'year,ppm' })
  await sw.install()
  sw.requested.length = 0

  assert.equal(await (await sw.request('/data/co2.csv'))!.text(), 'year,ppm')
  assert.deepEqual(sw.requested, [`${ORIGIN}/data/co2.csv`])

  sw.network.online = false
  assert.equal(await (await sw.request('/data/co2.csv'))!.text(), 'year,ppm')
})

test('cross-origin requests are left to the browser', async () => {
  const sw = loadWorker(SHELL_FILES)
  await sw.install()
  assert.equal(await sw.request('https://elsewhere.test/thing.js'), undefined)
})

test('activating a new version installs the new build and evicts the previous cache', async () => {
  const sw = loadWorker({ ...SHELL_FILES, '/index.html': 'shell v2', '/assets/index.js': 'bundle v2' })
  sw.caches.set('eventable-old', new Map([[`${ORIGIN}/index.html`, new Response('shell v1')]]))

  await sw.install()
  await sw.activate()

  assert.deepEqual([...sw.caches.keys()], ['eventable-test'], 'the superseded cache is gone')
  sw.network.online = false
  assert.equal(await (await sw.request('/', 'navigate'))!.text(), 'shell v2')
})

test('the build stamp changes when the build changes and holds steady when it does not', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-stamp-'))
  mkdirSync(path.join(dir, 'assets'))
  writeFileSync(path.join(dir, 'assets/index.js'), 'bundle v1')
  writeFileSync(path.join(dir, 'index.html'), 'shell')

  const first = stampServiceWorker(dir)
  // Re-stamping an unchanged build must be a no-op: the previous stamp now sits
  // in dir/sw.js, and a hash that folded it in would drift on every rebuild and
  // reload the page forever.
  assert.equal(stampServiceWorker(dir), first)
  assert.match(readFileSync(path.join(dir, 'sw.js'), 'utf8'), new RegExp(`'${first}'`))

  writeFileSync(path.join(dir, 'assets/index.js'), 'bundle v2')
  assert.notEqual(stampServiceWorker(dir), first)
})
