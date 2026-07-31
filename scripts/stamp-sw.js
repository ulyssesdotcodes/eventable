// Stamp the built service worker with a version derived from the build's
// contents. static/sw.js serves cache-first, so this hash is the only signal
// that a deploy happened: it has to change whenever any served file changes,
// and stay identical when none did — an unchanged worker script is what keeps
// a reload from firing on every visit. The built sw.js is excluded because it
// carries the previous stamp on a rebuild, which would make the hash chase its
// own tail; the template is folded in instead, so editing the worker itself
// still mints a new cache.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function stampServiceWorker(dir = 'public', template = 'static/sw.js') {
  const source = readFileSync(template, 'utf8')
  const hash = createHash('sha256').update(source)
  for (const rel of readdirSync(dir, { recursive: true }).sort()) {
    const file = path.join(dir, rel)
    if (rel === 'sw.js' || !statSync(file).isFile()) continue
    hash.update(rel).update(readFileSync(file))
  }
  const version = hash.digest('hex').slice(0, 12)
  writeFileSync(path.join(dir, 'sw.js'), source.replaceAll('__BUILD_VERSION__', version))
  return version
}
