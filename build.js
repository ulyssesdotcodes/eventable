import * as esbuild from 'esbuild'
import { solidPlugin } from 'esbuild-plugin-solid'
import { rmSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'fs'
import { writeLangEnv } from './scripts/gen-lang-env.js'
import { stampServiceWorker } from './scripts/stamp-sw.js'

rmSync('public', { recursive: true, force: true })
mkdirSync('public/assets', { recursive: true })
cpSync('src/data', 'public/data', { recursive: true })
cpSync('static', 'public', { recursive: true })
// Self-hosted feather-icons (see index.html) — bundled so the app has no
// third-party runtime dependency and works offline.
cpSync('node_modules/feather-icons/dist/feather.min.js', 'public/assets/feather.min.js')

// The language-service environment the lang worker fetches at startup — see
// scripts/gen-lang-env.js.
writeLangEnv('public/assets/lang-env.json')

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  minify: true,
  outfile: 'public/assets/index.js',
  format: 'esm',
  external: ['module'],
  plugins: [solidPlugin()],
})

// The cook worker bundle. 'module' stays external because Jolt's emscripten
// glue has a node-only `await import("module")` branch that must not be
// resolved at build time; the browser never reaches it.
await esbuild.build({
  entryPoints: ['src/cook-worker.ts'],
  bundle: true,
  minify: true,
  outfile: 'public/assets/cook-worker.js',
  format: 'esm',
  external: ['module'],
})

// The language-service worker: TypeScript itself bundled for the browser
// (~3.5 MB minified), loaded lazily by the editor.
await esbuild.build({
  entryPoints: ['src/lang-worker.ts'],
  bundle: true,
  minify: true,
  outfile: 'public/assets/lang-worker.js',
  format: 'esm',
})

const html = readFileSync('index.html', 'utf8')
  .replace('</head>', '    <link rel="stylesheet" href="./assets/index.css">\n  </head>')
  .replace('src="/src/main.ts"', 'src="./assets/index.js"')
writeFileSync('public/index.html', html)

// Version the service worker off the finished build, so a deploy activates a
// fresh cache, evicts the previous one, and reloads open pages (static/sw.js).
stampServiceWorker()
