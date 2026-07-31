// eventable post — the post-processing chain language (pure half). Code cells
// evaluate like hydra sketches: `new Function` over a fixed scope of head
// factories (`scene()`, later `src(bN)` and generators), each returning a chain
// builder whose fluent ops (`.edges(...)`, `.blur(...)`, …) accumulate an
// immutable op list. Nothing GPU happens here — the op list is data; the TSL
// factories that turn it into a node graph live in post-scene.ts (which owns
// the `three` imports). This module carries the op REGISTRY (the single source
// of truth for op names, arg counts, and the live/structural classification of
// each arg) plus the eval, structural-signature, and live-arg traversal that
// both the fold (post.ts) and the engine (post-scene.ts) share.

// Every op argument is either `live` — bound to a `uniform()` node the engine
// rewrites each frame (a plain number lowers to a constant-valued uniform, a
// function is evaluated per frame against the props object) — or `structural`:
// baked into the compiled shader, so changing one selects a different
// precompiled state. This is what lets generic table columns drive arbitrary
// parameters: `edges(0.25, 1)` never recompiles when 0.25 changes, only when
// the structural colorMode does.
import { FPS } from './constants.js'

export type ArgClass = 'live' | 'structural'
export type OpKind = 'head' | 'fx' | 'combine'

export interface ArgSpec {
  name: string
  arg: ArgClass
  default: number
}

export interface OpSpec {
  kind: OpKind
  args: ArgSpec[]
  doc: string
}

// The op registry. Each entry's `make` (the TSL factory) is registered
// separately in post-scene.ts under the same name; keeping the factories out of
// this module keeps it (and its tests) free of the `three` import graph.
export const POST_OPS: Record<string, OpSpec> = {
  scene: { kind: 'head', args: [], doc: 'The raw rendered scene — only needed inside a branch arg (e.g. mask(scene())); a top-level chain already starts from the scene.' },
  prev: { kind: 'head', args: [], doc: 'The previous output frame — one-frame-behind feedback. Use as a branch arg, e.g. blend(prev(), 0.4).' },
  blend: { kind: 'combine', args: [{ name: 'amount', arg: 'live', default: 0.5 }], doc: 'Cross-fade another chain over this one by `amount` (0–1, live).' },
  add: { kind: 'combine', args: [], doc: 'Add another chain to this one.' },
  mult: { kind: 'combine', args: [], doc: 'Multiply this chain by another.' },
  diff: { kind: 'combine', args: [], doc: 'Absolute difference between this chain and another.' },
  mask: { kind: 'combine', args: [], doc: 'Multiply this chain by another chain\'s luminance.' },
  layer: { kind: 'combine', args: [], doc: 'Composite another chain over this one using the layer\'s alpha.' },
  modulate: {
    kind: 'combine',
    args: [{ name: 'amount', arg: 'live', default: 0.1 }],
    doc: 'Displace this chain\'s pixels by another chain\'s red/green channels, scaled by `amount` (live) — hydra\'s modulate. A mid-grey modulator leaves the view untouched; brighter/darker regions push it around.',
  },
  transition: { kind: 'head', args: [], doc: 'Per-pixel wipe between two chains: every frame composites before→after by the mask\'s luminance (black keeps before, white shows after). The fold builds it from a transition event; time comes only from a mask reading progress().' },
  fill: { kind: 'head', args: [{ name: 'amount', arg: 'live', default: 0 }], doc: 'A flat luminance field (live) — the uniform mask a bare transition value lowers to: fill(progress()) is a crossfade, fill(0.5) a static half-blend.' },
  gradient: {
    kind: 'head',
    args: [
      { name: 'angle', arg: 'live', default: 0 },
      { name: 'colorMode', arg: 'structural', default: 0 },
    ],
    doc: 'Linear ramp across the screen at `angle` radians (live). `colorMode` (structural) picks what ramps: 0 = a 0→1 luminance ramp (gradient(0) = black left → white right; feed it to thresh(progress().oneSub()) for a directional wipe), 1 = a full hue sweep, so it works as a colour source for blend/mult.',
  },
  noise: {
    kind: 'head',
    args: [
      { name: 'scale', arg: 'live', default: 3 },
      { name: 'octaves', arg: 'structural', default: 1 },
    ],
    doc: 'Static Perlin (gradient) noise luminance at `scale` cells across (live) — a smooth dissolve/modulation source; deterministic (no self-animation, drive it with progress()). `octaves` (structural, 1–4) stacks halving-amplitude layers for fractal detail. noise(3).thresh(progress().oneSub()) dissolves; modulate(noise(6), 0.1) warps.',
  },
  voronoi: {
    kind: 'head',
    args: [
      { name: 'scale', arg: 'live', default: 6 },
      { name: 'jitter', arg: 'live', default: 1 },
    ],
    doc: 'Cellular (Worley) noise: `scale` cells across, each with a feature point offset by `jitter` (0 = a regular grid, 1 = fully scattered; both live). Luminance is the distance to the nearest point — dark cell centres, bright borders. voronoi(8).thresh(progress().oneSub()) shatters; invert it for glowing cracks.',
  },
  stripes: {
    kind: 'head',
    args: [{ name: 'count', arg: 'live', default: 8 }, { name: 'angle', arg: 'live', default: 0 }],
    doc: 'Repeating 0→1 luminance ramps — `count` bands at `angle` radians (both live). Blinds: stripes(8).thresh(progress().oneSub()); with .polar() they become concentric rings.',
  },
  thresh: {
    kind: 'fx',
    args: [{ name: 'edge', arg: 'live', default: 0.5 }, { name: 'softness', arg: 'live', default: 0.1 }],
    doc: 'Turn a grayscale into a moving wipe edge: pixels ABOVE `edge` become white (show the next chain), below stay black, with a `softness`-wide smooth border (both live). Ride `edge` on progress().oneSub() so the reveal grows as the wipe runs — gradient(0).thresh(progress().oneSub()).',
  },
  polar: {
    kind: 'fx',
    args: [{ name: 'cx', arg: 'live', default: 0.5 }, { name: 'cy', arg: 'live', default: 0.5 }],
    doc: 'Resample the chain in polar coordinates about (cx, cy) (live): the input\'s x axis reads as normalized RADIUS (0 centre → 1 far corner), its y axis as ANGLE (0→1 per turn). gradient(Math.PI).polar() is a centre-bright radial ramp (a centre-outward iris under thresh(progress().oneSub())), gradient(Math.PI/2).polar() an angular one (clock).',
  },
  edges: {
    kind: 'fx',
    args: [
      { name: 'threshold', arg: 'live', default: 0.2 },
      { name: 'colorMode', arg: 'structural', default: 0 },
    ],
    doc: 'Sobel edge detection. `threshold` (live) cuts weak edges; `colorMode` (structural) picks the look: 0 = white-on-black, 1 = edges over the source, 2 = hue by edge direction.',
  },
  blur: {
    kind: 'fx',
    args: [{ name: 'radius', arg: 'live', default: 4 }],
    doc: 'Separable Gaussian blur (horizontal then vertical). `radius` (live) scales the sample spread with no recompile.',
  },
  bloom: {
    kind: 'fx',
    args: [
      { name: 'strength', arg: 'live', default: 0.6 },
      { name: 'radius', arg: 'live', default: 0.5 },
      { name: 'threshold', arg: 'live', default: 0 },
    ],
    doc: 'Additive bloom over bright areas. `strength`, `radius` (0–1), and `threshold` are all live.',
  },
  pixelate: {
    kind: 'fx',
    args: [{ name: 'size', arg: 'live', default: 6 }],
    doc: 'Quantize to square blocks `size` pixels across (live).',
  },
  posterize: {
    kind: 'fx',
    args: [{ name: 'steps', arg: 'live', default: 4 }],
    doc: 'Quantize each colour channel to `steps` levels (live).',
  },
  invert: { kind: 'fx', args: [], doc: 'Invert the colour (1 − c).' },
  rgbshift: {
    kind: 'fx',
    args: [{ name: 'amount', arg: 'live', default: 0.005 }],
    doc: 'Chromatic aberration: split the red and blue channels apart by `amount` in UV space (live).',
  },
  mosaic: {
    kind: 'fx',
    args: [{ name: 'scale', arg: 'live', default: 8 }],
    doc: 'Mirror-tile the image into a `scale`×`scale` kaleidoscope grid (live).',
  },
  scale: {
    kind: 'fx',
    args: [{ name: 'amount', arg: 'live', default: 1.5 }],
    doc: 'Zoom the scene around its centre by `amount` (live): >1 magnifies, <1 pulls back (edges clamp).',
  },
  rotate: {
    kind: 'fx',
    args: [{ name: 'angle', arg: 'live', default: 0.4 }],
    doc: 'Rotate the scene around its centre by `angle` radians (live).',
  },
  scrollX: {
    kind: 'fx',
    args: [{ name: 'amount', arg: 'live', default: 0.1 }],
    doc: 'Pan horizontally by `amount` of the width, wrapping around the far edge (live).',
  },
  scrollY: {
    kind: 'fx',
    args: [{ name: 'amount', arg: 'live', default: 0.1 }],
    doc: 'Pan vertically by `amount` of the height, wrapping around the far edge (live).',
  },
  kaleid: {
    kind: 'fx',
    args: [{ name: 'sides', arg: 'live', default: 4 }],
    doc: 'Kaleidoscope: fold the scene into `sides` mirrored angular wedges around the centre (live).',
  },
  hue: {
    kind: 'fx',
    args: [{ name: 'amount', arg: 'live', default: 0.1 }],
    doc: 'Rotate every colour\'s hue by `amount` turns (live; 1 = a full circle), keeping luminance.',
  },
  saturate: {
    kind: 'fx',
    args: [{ name: 'amount', arg: 'live', default: 1.5 }],
    doc: 'Scale colour saturation by `amount` (live): 0 = greyscale, 1 = unchanged, >1 = more vivid.',
  },
  brightness: {
    kind: 'fx',
    args: [{ name: 'amount', arg: 'live', default: 0.2 }],
    doc: 'Add `amount` to every channel (live); negative darkens.',
  },
  contrast: {
    kind: 'fx',
    args: [{ name: 'amount', arg: 'live', default: 1.4 }],
    doc: 'Scale contrast around mid-grey by `amount` (live): 1 = unchanged, >1 = punchier, <1 = flatter.',
  },
  fade: {
    kind: 'fx',
    args: [{ name: 'amount', arg: 'live', default: 0.5 }],
    doc: 'Feedback trail: blend the previous output frame into this one by `amount` (live; higher = longer-lived trails). Reads the same one-frame-behind buffer as prev().',
  },
  strobe: {
    kind: 'fx',
    args: [{ name: 'speed', arg: 'live', default: 4 }],
    doc: 'Beat-locked brightness strobe: pulses on the beat clock at `speed` cycles per beat (deterministic — no wall time).',
  },
  film: {
    kind: 'fx',
    args: [{ name: 'intensity', arg: 'live', default: 0.3 }],
    doc: 'Film grain seeded by the beat clock (deterministic; scrubs and pauses with the timeline). `intensity` is live.',
  },
  rgbsplit: { kind: 'fx', args: [], doc: 'Beat-quantized channel-strobe: offsets the R/B channels in steps locked to the beat clock.' },
}

// A live arg carries either a constant (lowered to a uniform holding it) or a
// per-frame function of the props object; a structural arg carries a baked
// number.
export type LiveValue = number | ((props: Record<string, unknown>) => number)

// A post live-arg handle: a per-frame (p) => number closure carrying a small
// fluent surface (oneSub — the 1 − x reflection) so authors reshape it inline,
// e.g. progress().oneSub(). The result is still a plain function, so it lowers
// to the same uniform as any live arg with no recompile, and composes
// (oneSub().oneSub()).
export type LiveArgFn = ((p: Record<string, unknown>) => number) & { oneSub(): LiveArgFn }
export function liveArg(fn: (p: Record<string, unknown>) => number): LiveArgFn {
  const f = fn as LiveArgFn
  f.oneSub = (): LiveArgFn => liveArg((p) => 1 - fn(p))
  return f
}

export interface OpArgVal {
  cls: ArgClass
  value: LiveValue
}
export interface OpCall {
  op: string
  kind: OpKind
  args: OpArgVal[]
  // Chain arguments: a combine (blend/layer/mask/…) carries one; a transition
  // carries the before/after (and optional mask) chains it wipes between.
  chainArgs?: OpChain[]
}
export type OpChain = OpCall[]

// Classify one call site's raw arguments against the op's registry spec. A
// structural slot bakes to a number (its default when not a number); a live
// slot keeps a number or a function verbatim, coercing a numeric string and
// falling back to the default for anything unusable.
function makeCall(op: string, kind: OpKind, spec: ArgSpec[], raw: unknown[], chainArgs?: OpChain[]): OpCall {
  const args = spec.map((s, i): OpArgVal => {
    const r = raw[i]
    if (s.arg === 'structural') {
      return { cls: 'structural', value: typeof r === 'number' && Number.isFinite(r) ? r : s.default }
    }
    if (typeof r === 'function') return { cls: 'live', value: r as (p: Record<string, unknown>) => number }
    if (exprArgs?.isExpr(r)) return { cls: 'live', value: exprArgs.toLiveFn(r) }
    if (typeof r === 'number' && Number.isFinite(r)) return { cls: 'live', value: r }
    if (typeof r === 'string' && r.trim() !== '') {
      const n = Number(r)
      return { cls: 'live', value: Number.isFinite(n) ? n : s.default }
    }
    return { cls: 'live', value: s.default }
  })
  return { op, kind, args, chainArgs }
}

// The fluent chain builder a head factory returns. Every fx/combine op in the
// registry is a method here; combine ops take another chain (or a bare head
// value) as their first argument.
class ChainBuilder {
  ops: OpChain
  constructor(head: OpCall) {
    this.ops = [head]
  }
}

function installOps(): void {
  for (const [name, spec] of Object.entries(POST_OPS)) {
    if (spec.kind === 'head') continue
    if (spec.kind === 'combine') {
      ;(ChainBuilder.prototype as unknown as Record<string, unknown>)[name] = function (this: ChainBuilder, chain: unknown, ...rest: unknown[]): ChainBuilder {
        this.ops.push(makeCall(name, spec.kind, spec.args, rest, [chainOps(chain)]))
        return this
      }
    } else {
      ;(ChainBuilder.prototype as unknown as Record<string, unknown>)[name] = function (this: ChainBuilder, ...rest: unknown[]): ChainBuilder {
        this.ops.push(makeCall(name, spec.kind, spec.args, rest))
        return this
      }
    }
  }
}
installOps()

function chainOps(value: unknown): OpChain {
  if (value instanceof ChainBuilder) return value.ops
  throw new Error('post: combine op expected a chain argument')
}

// val("name", value) declarations in a cell, matched textually (literal name,
// optional numeric literal) so the editable-table fold can derive its
// "setVariable" rows without evaluating the chain — and regardless of whether the rest of
// the cell parses. First mention of a name in a cell wins.
const VAR_DECL = /\bval\b\s*\(\s*(['"`])(.*?)\1\s*(?:,\s*(-?(?:\d+(?:\.\d+)?|\.\d+)))?\s*\)/g
export interface PostVarDecl {
  name: string
  value: number
}
export function postVarDecls(code: string): PostVarDecl[] {
  const out: PostVarDecl[] = []
  const seen = new Set<string>()
  for (const m of code.matchAll(VAR_DECL)) {
    if (!m[2] || seen.has(m[2])) continue
    seen.add(m[2])
    out.push({ name: m[2], value: m[3] !== undefined ? Number(m[3]) : 0 })
  }
  return out
}

// Expr values as live args — bloom(expr.midi("c4")) — and the `expr`
// namespace in the cell scope. The adapter is injected (expr-cell.ts
// registers it) so this module stays off the DSL import graph, which
// editable-tables depends on.
export interface ExprArgSupport {
  isExpr(v: unknown): boolean
  toLiveFn(v: unknown): (p: Record<string, unknown>) => number
  makeScope(defineSlider: (id: string, min?: number, max?: number) => void): unknown
}
let exprArgs: ExprArgSupport | null = null
export function registerExprArgSupport(s: ExprArgSupport): void {
  exprArgs = s
}

// Collector active while sliderDeclsInCode scans a cell; frame-time evals run
// with it unset, so they never write anywhere.
let sliderDefiner: ((id: string, min?: number, max?: number) => void) | null = null

export interface SliderDecl {
  id: string
  min?: number
  max?: number
}

// Every slider(name, min, max) declaration a post code cell makes, found by
// evaluating the cell against the chain scope with a collector installed. A
// leading-dot fragment (an "add" row) is tolerated; a cell that doesn't parse
// standalone (mid-edit, unknown op) declares nothing. The cook reports these
// alongside expr.slider's declarations, so they land once per run.
export function sliderDeclsInCode(code: string): SliderDecl[] {
  const out: SliderDecl[] = []
  const prev = sliderDefiner
  sliderDefiner = (id, min, max) =>
    out.push({ id, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) })
  try {
    evalPostCode(code.trim().replace(/^\./, ''))
  } catch { /* a broken or partial cell declares nothing */ }
  finally {
    sliderDefiner = prev
  }
  return out
}

// The eval scope. The scene is the implicit source, so every fx/combine op is
// callable top-level to START a chain applied to the scene — `edges(0.2)` is
// exactly `scene().edges(0.2)`. `scene()`/`prev()` are explicit heads (for
// branch args and feedback); `transition` is the fold-built wipe.
function headScope(): Record<string, unknown> {
  const scope: Record<string, unknown> = {}
  scope.scene = (): ChainBuilder => new ChainBuilder(makeCall('scene', 'head', [], []))
  scope.prev = (): ChainBuilder => new ChainBuilder(makeCall('prev', 'head', [], []))
  for (const [name, spec] of Object.entries(POST_OPS)) {
    if (spec.kind === 'head') {
      // Generator heads (gradient/noise/stripes/fill) start a chain from a
      // synthesised field; scene/prev/transition are installed explicitly.
      if (name === 'scene' || name === 'prev' || name === 'transition') continue
      scope[name] = (...raw: unknown[]): ChainBuilder => new ChainBuilder(makeCall(name, 'head', spec.args, raw))
      continue
    }
    scope[name] = (...raw: unknown[]): ChainBuilder => {
      const cb = new ChainBuilder(makeCall('scene', 'head', [], []))
      if (spec.kind === 'combine') cb.ops.push(makeCall(name, spec.kind, spec.args, raw.slice(1), [chainOps(raw[0])]))
      else cb.ops.push(makeCall(name, spec.kind, spec.args, raw))
      return cb
    }
  }
  // A live post variable — val("glow", 0.5) — reading the folded variable
  // each frame with the initial as the fallback. The editable-table fold
  // materializes a "setVariable" row for each val() right after the cell it appears in.
  scope.val = (name: unknown, value?: unknown): LiveArgFn => {
    const key = String(name)
    const fallback = typeof value === 'number' && Number.isFinite(value) ? value : 0
    return liveArg((p) => {
      const v = p[key]
      return typeof v === 'number' ? v : fallback
    })
  }
  // A live on-screen slider, usable anywhere a live arg is — blur(slider("r",
  // 0, 8)) — reading props.sliders each frame. The cook declares the control
  // from these calls (see sliderDeclsInCode).
  scope.slider = (name: unknown, min?: unknown, max?: unknown): LiveArgFn => {
    const id = String(name)
    const lo = typeof min === 'number' && Number.isFinite(min) ? min : undefined
    const hi = typeof max === 'number' && Number.isFinite(max) ? max : undefined
    sliderDefiner?.(id, lo, hi)
    return liveArg((p) => {
      const v = (p.sliders as Record<string, number> | undefined)?.[id]
      return typeof v === 'number' ? v : lo ?? 0
    })
  }
  // The expr namespace — expr.midi("c4"), expr.slider("r", 0, 8).mul(2), … —
  // usable anywhere a live arg is; expr.slider declares through the same
  // collector as the bare slider().
  if (exprArgs) scope.expr = exprArgs.makeScope((id, min, max) => sliderDefiner?.(id, min, max))
  // progress() — a live arg reading the enclosing transition's window fraction
  // (0 at the transition's beat, 1 at the next setCode), rebound per frame from
  // the playback clock like slider()/val(). Outside a transition mask it reads 1.
  scope.progress = (): LiveArgFn => progressFn
  // A transition is the head of the output chain the fold produces: it mixes
  // `before` → `after` per pixel by the `mask` chain's luminance, every frame.
  // The mask is passed as a THUNK so its progress() calls bind to THIS
  // transition's window (start/len/seqLen/ease) — nested transitions each get
  // their own. A bare number or live-fn mask lowers to a uniform luminance
  // (fill), so `() => 0.5` is a static half-blend and `() => progress()` a
  // crossfade.
  scope.transition = (
    before: unknown, after: unknown, maskThunk: unknown,
    startFrame: unknown, lenFrames: unknown, seqLen: unknown, ease: unknown,
  ): ChainBuilder => {
    const mask = withProgress(
      windowProgress(Number(startFrame), Number(lenFrames), Number(seqLen), ease),
      () => normalizeMask((maskThunk as () => unknown)()),
    )
    const call = makeCall('transition', 'head', [], [])
    call.chainArgs = [chainOps(before), chainOps(after), mask.ops]
    return new ChainBuilder(call)
  }
  return scope
}

// A bare-value mask (number or live fn) becomes a uniform luminance field; a
// chain passes through. Anything else is an authoring error.
function normalizeMask(mask: unknown): ChainBuilder {
  if (mask instanceof ChainBuilder) return mask
  if (typeof mask === 'number' || typeof mask === 'function' || exprArgs?.isExpr(mask)) {
    return new ChainBuilder(makeCall('fill', 'head', POST_OPS.fill.args, [mask]))
  }
  throw new Error('post: transition mask must be a chain, number, or live arg')
}

// The live progress fn a transition mask's progress() reads. Default (outside a
// transition) reads 1 — a fully-arrived event.
let progressFn: LiveArgFn = liveArg(() => 1)

// Run `build` with progressFn set to `fn`, restoring the previous binding after
// (a stack via the saved `prev`, so nested transition masks each see their own).
function withProgress(fn: LiveArgFn, build: () => ChainBuilder): ChainBuilder {
  const prev = progressFn
  progressFn = fn
  try { return build() } finally { progressFn = prev }
}

const clampU = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const easeU: Record<string, (u: number) => number> = {
  linear: (u) => u,
  easeIn: (u) => u * u,
  easeOut: (u) => 1 - (1 - u) ** 2,
  easeInOut: (u) => (u < 0.5 ? 2 * u * u : 1 - ((-2 * u + 2) ** 2) / 2),
}

// The eased 0→1 window fraction at the playback frame (p.time·FPS), wrapped over
// the content cycle (seqLen>0) exactly as transitionAt does — so a window that
// crosses the loop seam still reads right when the playhead re-samples [0, len).
function windowProgress(
  startFrame: number, lenFrames: number, seqLen: number, ease: unknown,
): LiveArgFn {
  const shape = easeU[(typeof ease === 'string' && ease in easeU ? ease : 'linear')]
  return liveArg((p) => {
    const frame = (typeof p.time === 'number' ? p.time : 0) * FPS
    const dist = seqLen > 0 ? ((frame - startFrame) % seqLen + seqLen) % seqLen : frame - startFrame
    return shape(clampU(lenFrames > 0 ? dist / lenFrames : 1))
  })
}

// Evaluate a post code cell to its op list. The cell is an expression like
// `edges((p) => p.th, 1).bloom(0.3)` (the scene is implicit); it runs against
// the scope and must return a chain builder. Throws on a syntax/unknown-op —
// including a trailing line comment, which the `return (...)` wrap can't close.
export function evalPostCode(code: string): OpChain {
  const scope = headScope()
  const keys = Object.keys(scope)
  const fn = new Function(...keys, `"use strict"; return (${code});`)
  const result = fn(...keys.map((k) => scope[k])) as unknown
  if (!(result instanceof ChainBuilder)) throw new Error('post: code cell must return a chain (did you start with scene()?)')
  return result.ops
}

// The structural signature of a chain: op names with structural args inlined
// and live args masked to `#`. Two chains share a precompiled state exactly
// when their signatures match, so a live-literal edit (or a function arg) never
// forces a new graph.
export function chainSignature(chain: OpChain): string {
  return chain
    .map((op) => {
      const args = op.args.map((a) => (a.cls === 'structural' ? String(a.value) : '#')).join(',')
      const sub = op.chainArgs ? `{${op.chainArgs.map(chainSignature).join('|')}}` : ''
      return `${op.op}(${args})${sub}`
    })
    .join('.')
}

// Visit every live arg in the deterministic order the engine binds uniforms:
// each op in chain order, its own live args in arg order, then (for a combine)
// its sub-chain. buildGraph in post-scene.ts walks identically, so the i-th
// visited value maps to the i-th created uniform.
export function forEachLiveArg(chain: OpChain, cb: (value: LiveValue) => void): void {
  for (const op of chain) {
    for (const a of op.args) if (a.cls === 'live') cb(a.value)
    if (op.chainArgs) for (const sub of op.chainArgs) forEachLiveArg(sub, cb)
  }
}

// Resolve every live arg to a number against `props` (functions evaluated,
// constants passed through), in binding order.
export function collectLiveValues(chain: OpChain, props: Record<string, unknown>): number[] {
  const out: number[] = []
  forEachLiveArg(chain, (v) => {
    const n = typeof v === 'function' ? Number(v(props)) : v
    out.push(Number.isFinite(n) ? n : 0)
  })
  return out
}
