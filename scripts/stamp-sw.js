// Stamp the built service worker with a hash of the build. static/sw.js serves
// cache-first, so this is the only signal that a deploy happened: it must move
// whenever a served file changes and hold steady when none did, or every visit
// reloads. The built sw.js is excluded — it carries the previous stamp, so the
// hash would chase its own tail; the template is folded in instead, so editing
// the worker still mints a new cache.

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
