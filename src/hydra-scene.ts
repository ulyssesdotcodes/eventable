// eventable hydra-scene — the hydra-ts GPU layer. Source s0 is the Three.js
// scene canvas, output o0 the visible canvas. Sketch variables flow through
// hydra-ts's per-frame `props` callback, not baked into the compiled code, so
// a value can change every frame without a shader-rebuilding recompile. tick()
// is driven only by the playback clock (hydra-ts starts no loop of its own),
// so pausing/scrubbing the timeline pauses/scrubs the sketch.

import { Hydra } from 'hydra-ts'
import createREGL from 'regl'
import { makeHydraExprScope } from './expr-cell.js'
import type { HydraFrame } from './hydra.js'

export interface HydraAPI {
  setSketch(frame: HydraFrame | null): void
  tick(timeSeconds: number): void
  reset(): void
  // Force the regl-refresh/redraw sequence a real window resize triggers —
  // hydra occasionally wedges into a stuck error state that only this (not
  // reset()) clears.
  reinit(): void
}

// Shown before the first code row: the scene passed straight through.
const PASSTHROUGH = 'src(s0).out(o0)'

// `source` becomes hydra's s0; each canvas in `extras` becomes the next source
// in order (main.ts wires the bauble canvas in as s1).
export function initHydra(canvas: HTMLCanvasElement, source: HTMLCanvasElement, ...extras: HTMLCanvasElement[]): HydraAPI {
  const width = canvas.width || 1280
  const height = canvas.height || 720
  const regl = createREGL({ canvas, pixelRatio: 1 })

  // Read fresh by hydra-ts on every draw, so a variable can change per frame
  // without recompiling. hydra-ts merges its own per-frame fields (time, bpm,
  // fps, resolution, speed, stats) LAST, so those names always shadow a
  // same-named sketch variable.
  let currentVars: Record<string, unknown> = {}

  const hydra = new Hydra({ regl, width, height, props: () => currentVars })

  // `dynamic` re-uploads the texture every frame so the live render keeps
  // flowing through.
  hydra.sources[0].init({ src: source, dynamic: true })
  extras.forEach((extra, i) => hydra.sources[i + 1]?.init({ src: extra, dynamic: true }))

  // The compiled sketch's scope: hydra's generator functions plus each source/
  // output by name, exactly like a hydra-synth sketch's globals.
  const scope: Record<string, unknown> = { ...hydra.generators }
  hydra.sources.forEach((s, i) => { scope['s' + i] = s })
  hydra.outputs.forEach((o, i) => { scope['o' + i] = o })
  // expr sources as dynamic args — osc(expr.midi("c4").mul(20)); callable
  // Exprs, since hydra-ts only accepts functions of the per-frame props.
  scope.expr = makeHydraExprScope()
  const scopeKeys = Object.keys(scope)
  const scopeValues = scopeKeys.map((k) => scope[k])

  function resize(): void {
    const parent = canvas.parentElement
    if (!parent) return
    const w = parent.clientWidth
    const h = parent.clientHeight
    if (w && h) {
      // hydra-ts's setResolution only resizes its internal FBOs — the canvas
      // drawing-buffer size is ours to set, and regl needs an explicit nudge.
      canvas.width = w
      canvas.height = h
      regl._refresh()
      hydra.setResolution(w, h)
      hydra.tick(0) // redraw at the new resolution even while paused
    }
  }
  resize()
  if (canvas.parentElement) new ResizeObserver(resize).observe(canvas.parentElement)

  let lastCode: string | null = null

  function compile(code: string): void {
    try {
      const fn = new Function(...scopeKeys, code)
      fn(...scopeValues)
    } catch (err) {
      console.error('hydra sketch error:', err)
    }
  }

  function setSketch(frame: HydraFrame | null): void {
    const code = frame?.code ?? PASSTHROUGH
    currentVars = frame?.vars ?? {}
    if (code === lastCode) return
    lastCode = code
    compile(code)
  }

  let lastTimeSeconds = 0

  function tick(timeSeconds: number): void {
    hydra.tick((timeSeconds - lastTimeSeconds) * 1000)
    lastTimeSeconds = timeSeconds
  }

  // Start in passthrough so the scene is visible the moment hydra comes up.
  setSketch(null)
  tick(0)

  return {
    setSketch,
    tick,
    reset(): void {
      lastCode = null
      lastTimeSeconds = 0
      setSketch(null)
      tick(0)
    },
    reinit: resize,
  }
}
