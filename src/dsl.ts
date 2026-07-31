// livecodata DSL — chainable tables of plain row objects that drive visuals.
// All timing is in beats (1-indexed; no seconds in the data model). A Table is
// a node in a lazy op-graph, content-hashed (Merkle) so unchanged subgraphs
// reuse their previous rows; the declarative Expr verbs exist so specs stay
// data (soundly hashable) — function verbs hash by source text + run seed,
// best-effort.
//
// JSDoc in this file is deliberately verbose: gen-lang-env.js lifts the JSDoc
// on DSLSurface members (and the emitted .d.ts of Table & friends) into the
// editor's CodeMirror hover docs, so the livecoder — not this file's reader —
// is its audience. Use /** */ for anything the editor should show on hover.

import { rasterizeRows } from './rasterize.js'
import { timelineSegments, placeBeat } from './timeline.js'
import { withLineage, carry, unionLineage, getLineage, type Row } from './lineage.js'
import { FRAMES_PER_BEAT, DEFAULT_BEAT_SECONDS } from './constants.js'
import { compileFoldTable, foldValueAt, type FoldTableProgram } from './fold-engine.js'
import type { Schema } from './editable-tables.js'
import { beatSecondsFromTaps } from './tap-log.js'
import { primitiveGeometry, pointsFromGeometry, geometryFromPoints } from './three-points.js'
import type { BufferGeometry } from 'three'

// ── Expr: a serializable, chainable expression over a row ────────────────────
// Wraps a plain-JSON node (no functions) so it hashes soundly. Operands accept
// another Expr or a raw literal: field("beat").add(0.5).

type BinOp = 'add' | 'sub' | 'mul' | 'div' | 'mod'
type CmpOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'

export type ExprNode =
  | { k: 'field'; name: string }
  | { k: 'lit'; v: number | string | boolean | null }
  | { k: 'idx' }
  | { k: 'bin'; op: BinOp; a: ExprNode; b: ExprNode }
  | { k: 'cmp'; op: CmpOp; a: ExprNode; b: ExprNode }
  | { k: 'logic'; op: 'and' | 'or'; a: ExprNode; b: ExprNode }
  | { k: 'not'; a: ExprNode }
  | { k: 'cond'; t: ExprNode; a: ExprNode; b: ExprNode }
  // midi/slider/time read a streaming source at the current frame, so they
  // can't be resolved at bake time — bakeExpr defers them into per-row bindings.
  | { k: 'midi'; note: string; channel: number | null }
  | { k: 'slider'; id: string }
  | { k: 'time' }
  | { k: 'call'; fn: string; args: ExprNode[] }
  // Percent-done of the enclosing event: substituted with a literal where the
  // row's timing is known (substituteExpr); unsubstituted it reads as 1.
  | { k: 'progress' }

// The math functions a { k: 'call' } node can name — the single source of
// truth feeding evalExpr, the "=" cell scope (expr-cell.ts), and the editor
// docs. All pure and deterministic (no Math.random, no wall clock), which is
// what keeps replay/scrub exact.
export const EXPR_FNS: Record<string, { arity: number; apply: (...ns: number[]) => number; doc: string }> = {
  sin: { arity: 1, apply: Math.sin, doc: 'sine (radians)' },
  cos: { arity: 1, apply: Math.cos, doc: 'cosine (radians)' },
  tan: { arity: 1, apply: Math.tan, doc: 'tangent (radians)' },
  asin: { arity: 1, apply: Math.asin, doc: 'arcsine, in radians' },
  acos: { arity: 1, apply: Math.acos, doc: 'arccosine, in radians' },
  atan: { arity: 1, apply: Math.atan, doc: 'arctangent, in radians' },
  atan2: { arity: 2, apply: Math.atan2, doc: 'angle of the vector (y, x), in radians' },
  abs: { arity: 1, apply: Math.abs, doc: 'absolute value' },
  floor: { arity: 1, apply: Math.floor, doc: 'round down' },
  ceil: { arity: 1, apply: Math.ceil, doc: 'round up' },
  round: { arity: 1, apply: Math.round, doc: 'round to nearest' },
  sqrt: { arity: 1, apply: Math.sqrt, doc: 'square root' },
  exp: { arity: 1, apply: Math.exp, doc: 'e raised to x' },
  log: { arity: 1, apply: Math.log, doc: 'natural logarithm' },
  sign: { arity: 1, apply: Math.sign, doc: '-1, 0, or 1' },
  pow: { arity: 2, apply: (x, e) => Math.pow(x, e), doc: 'x raised to e' },
  min: { arity: 2, apply: (a, b) => Math.min(a, b), doc: 'smaller of two values' },
  max: { arity: 2, apply: (a, b) => Math.max(a, b), doc: 'larger of two values' },
  clamp: { arity: 3, apply: (x, lo, hi) => Math.min(Math.max(x, lo), hi), doc: 'limit x into [lo, hi]' },
  lerp: { arity: 3, apply: (a, b, t) => a + (b - a) * t, doc: 'blend a toward b by t (0–1)' },
  fract: { arity: 1, apply: (x) => x - Math.floor(x), doc: 'fractional part (0→1 sawtooth)' },
  wrap: {
    arity: 3,
    apply: (x, lo, hi) => {
      const span = hi - lo
      return span === 0 ? lo : lo + (((x - lo) % span) + span) % span
    },
    doc: 'wrap x into [lo, hi)',
  },
}

type ExprInput = Expr | number | string | boolean | null

const toNode = (x: ExprInput): ExprNode =>
  x instanceof Expr ? x.node : { k: 'lit', v: x }

export class Expr {
  node: ExprNode
  constructor(node: ExprNode) {
    this.node = node
  }

  private bin(op: BinOp, o: ExprInput): Expr {
    return new Expr({ k: 'bin', op, a: this.node, b: toNode(o) })
  }
  add(o: ExprInput): Expr { return this.bin('add', o) }
  sub(o: ExprInput): Expr { return this.bin('sub', o) }
  mul(o: ExprInput): Expr { return this.bin('mul', o) }
  div(o: ExprInput): Expr { return this.bin('div', o) }
  mod(o: ExprInput): Expr { return this.bin('mod', o) }

  private cmp(op: CmpOp, o: ExprInput): Expr {
    return new Expr({ k: 'cmp', op, a: this.node, b: toNode(o) })
  }
  eq(o: ExprInput): Expr { return this.cmp('eq', o) }
  ne(o: ExprInput): Expr { return this.cmp('ne', o) }
  gt(o: ExprInput): Expr { return this.cmp('gt', o) }
  gte(o: ExprInput): Expr { return this.cmp('gte', o) }
  lt(o: ExprInput): Expr { return this.cmp('lt', o) }
  lte(o: ExprInput): Expr { return this.cmp('lte', o) }

  and(o: Expr): Expr { return new Expr({ k: 'logic', op: 'and', a: this.node, b: o.node }) }
  or(o: Expr): Expr { return new Expr({ k: 'logic', op: 'or', a: this.node, b: o.node }) }
  not(): Expr { return new Expr({ k: 'not', a: this.node }) }

  /** Ternary: this ? then : otherwise — for picking a value declaratively. */
  cond(then: ExprInput, otherwise: ExprInput): Expr {
    return new Expr({ k: 'cond', t: this.node, a: toNode(then), b: toNode(otherwise) })
  }

  private callFn(fn: string, args: ExprInput[]): Expr {
    return new Expr({ k: 'call', fn, args: [this.node, ...args.map(toNode)] })
  }
  /** Sine of this value (radians) — a live input oscillates: expr.time().sin(). */
  sin(): Expr { return this.callFn('sin', []) }
  /** Cosine of this value (radians). */
  cos(): Expr { return this.callFn('cos', []) }
  /** Tangent of this value (radians). */
  tan(): Expr { return this.callFn('tan', []) }
  /** Arcsine, in radians. */
  asin(): Expr { return this.callFn('asin', []) }
  /** Arccosine, in radians. */
  acos(): Expr { return this.callFn('acos', []) }
  /** Arctangent, in radians. */
  atan(): Expr { return this.callFn('atan', []) }
  /** Angle of the vector (this, x) in radians — this value is the y component. */
  atan2(x: ExprInput): Expr { return this.callFn('atan2', [x]) }
  /** Absolute value. */
  abs(): Expr { return this.callFn('abs', []) }
  /** Round down to the nearest integer. */
  floor(): Expr { return this.callFn('floor', []) }
  /** Round up to the nearest integer. */
  ceil(): Expr { return this.callFn('ceil', []) }
  /** Round to the nearest integer. */
  round(): Expr { return this.callFn('round', []) }
  /** Square root. */
  sqrt(): Expr { return this.callFn('sqrt', []) }
  /** e raised to this value. */
  exp(): Expr { return this.callFn('exp', []) }
  /** Natural logarithm. */
  log(): Expr { return this.callFn('log', []) }
  /** The sign of this value: -1, 0, or 1. */
  sign(): Expr { return this.callFn('sign', []) }
  /** Fractional part (x - floor(x)) — a 0→1 sawtooth over a growing input like expr.time(). */
  fract(): Expr { return this.callFn('fract', []) }
  /** This value raised to the power `e` — field("v").pow(2). */
  pow(e: ExprInput): Expr { return this.callFn('pow', [e]) }
  /** The smaller of this and `o`. */
  min(o: ExprInput): Expr { return this.callFn('min', [o]) }
  /** The larger of this and `o`. */
  max(o: ExprInput): Expr { return this.callFn('max', [o]) }
  /** Limit this value into [lo, hi] — expr.slider("v").clamp(0, 1). */
  clamp(lo: ExprInput, hi: ExprInput): Expr { return this.callFn('clamp', [lo, hi]) }
  /** Blend from this value toward `b` by `t` (0–1) — a.lerp(b, expr.progress()) glides over the event. */
  lerp(b: ExprInput, t: ExprInput): Expr { return this.callFn('lerp', [b, t]) }
  /** Wrap this value into [lo, hi) — expr.time().wrap(0, 6.283) keeps an angle in range. */
  wrap(lo: ExprInput, hi: ExprInput): Expr { return this.callFn('wrap', [lo, hi]) }

  // Stable JSON form (used by the canonical serializer for hashing).
  toJSON(): { $expr: ExprNode } {
    return { $expr: this.node }
  }
}

export const field = (name: string): Expr => new Expr({ k: 'field', name })
export const lit = (v: number | string | boolean | null): Expr => new Expr({ k: 'lit', v })
export const idx = (): Expr => new Expr({ k: 'idx' })
export const midi = (note: string, channel: number | null = null): Expr =>
  new Expr({ k: 'midi', note: String(note).toLowerCase(), channel })

export const slider = (id: string): Expr =>
  new Expr({ k: 'slider', id: String(id) })

export const time = (): Expr => new Expr({ k: 'time' })

export const progress = (): Expr => new Expr({ k: 'progress' })

export const callExpr = (fn: string, args: ExprInput[]): Expr =>
  new Expr({ k: 'call', fn, args: args.map(toNode) })

// Per-frame evaluation context, supplied by playback at apply time; samplers
// read the streaming tables at the playhead's current source frame.
export interface EvalCtx {
  midi?: (note: string, channel: number | null) => number
  slider?: (id: string) => number
  sliders?: () => Record<string, number>
  // Playback seconds at the playhead — the same clock hydra/post chains see,
  // so pausing/scrubbing freezes/scrubs it.
  time?: () => number
}

// True if the node reads a streaming source and so must be carried as a
// binding and evaluated per frame rather than at bake time.
export function isStreamingNode(n: ExprNode): boolean {
  switch (n.k) {
    case 'midi': case 'slider': case 'time': case 'progress': return true
    case 'field': case 'lit': case 'idx': return false
    case 'not': return isStreamingNode(n.a)
    case 'bin': case 'cmp': case 'logic': return isStreamingNode(n.a) || isStreamingNode(n.b)
    case 'cond': return isStreamingNode(n.t) || isStreamingNode(n.a) || isStreamingNode(n.b)
    case 'call': return n.args.some(isStreamingNode)
    // Bindings cross the cook-transfer boundary, so an out-of-type node (an
    // older client meeting a newer wire shape) degrades to not-streaming at
    // runtime while the never-assert keeps the closed union a compile check.
    default: {
      const _exhaustive: never = n
      void _exhaustive
      return false
    }
  }
}

export function evalExpr(n: ExprNode, row: Row, i: number, ctx?: EvalCtx): unknown {
  switch (n.k) {
    case 'field': return row[n.name]
    case 'lit': return n.v
    case 'idx': return i
    case 'midi': return ctx?.midi ? ctx.midi(n.note, n.channel) : 0
    case 'slider': return ctx?.slider ? ctx.slider(n.id) : 0
    case 'time': return ctx?.time ? ctx.time() : 0
    case 'bin': {
      const a = evalExpr(n.a, row, i, ctx) as number
      const b = evalExpr(n.b, row, i, ctx) as number
      switch (n.op) {
        case 'add': return a + b
        case 'sub': return a - b
        case 'mul': return a * b
        case 'div': return a / b
        case 'mod': return a % b
      }
    }
    // eslint-disable-next-line no-fallthrough
    case 'cmp': {
      const a = evalExpr(n.a, row, i, ctx) as number
      const b = evalExpr(n.b, row, i, ctx) as number
      switch (n.op) {
        case 'eq': return a === b
        case 'ne': return a !== b
        case 'gt': return a > b
        case 'gte': return a >= b
        case 'lt': return a < b
        case 'lte': return a <= b
      }
    }
    // eslint-disable-next-line no-fallthrough
    case 'logic': {
      const a = evalExpr(n.a, row, i, ctx)
      return n.op === 'and' ? (a && evalExpr(n.b, row, i, ctx)) : (a || evalExpr(n.b, row, i, ctx))
    }
    case 'not': return !evalExpr(n.a, row, i, ctx)
    case 'cond': return evalExpr(n.t, row, i, ctx) ? evalExpr(n.a, row, i, ctx) : evalExpr(n.b, row, i, ctx)
    case 'call': {
      const f = EXPR_FNS[n.fn]
      if (!f) return 0
      return f.apply(...n.args.map((a) => Number(evalExpr(a, row, i, ctx))))
    }
    // An unsubstituted progress (no enclosing event window) reads as done.
    case 'progress': return 1
    // Unknown wire nodes evaluate to 0 rather than NaN — see isStreamingNode.
    default: {
      const _exhaustive: never = n
      void _exhaustive
      return 0
    }
  }
}

// Fold/bake-time substitution: progress → lit(u), field → lit(row[name]).
// Clones only the path down to each substituted node and returns the input
// unchanged when nothing below it matched — source nodes live inside memoized
// rows, so an in-place rewrite would freeze the first frame's values into the
// cook memo.
export function substituteExpr(n: ExprNode, sub: { progress?: number; fields?: Row }): ExprNode {
  switch (n.k) {
    case 'progress':
      return sub.progress !== undefined ? { k: 'lit', v: sub.progress } : n
    case 'field': {
      if (!sub.fields) return n
      const v = sub.fields[n.name]
      return { k: 'lit', v: typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : null }
    }
    case 'not': {
      const a = substituteExpr(n.a, sub)
      return a === n.a ? n : { k: 'not', a }
    }
    case 'bin': case 'cmp': case 'logic': {
      const a = substituteExpr(n.a, sub)
      const b = substituteExpr(n.b, sub)
      return a === n.a && b === n.b ? n : { ...n, a, b }
    }
    case 'cond': {
      const t = substituteExpr(n.t, sub)
      const a = substituteExpr(n.a, sub)
      const b = substituteExpr(n.b, sub)
      return t === n.t && a === n.a && b === n.b ? n : { k: 'cond', t, a, b }
    }
    case 'call': {
      const args = n.args.map((a) => substituteExpr(a, sub))
      return args.every((a, k) => a === n.args[k]) ? n : { k: 'call', fn: n.fn, args }
    }
    default:
      return n
  }
}

// ── Streaming bindings ───────────────────────────────────────────────────────
// A binding is a serializable { $expr } marker left in a row where the value
// reads a streaming source; rasterize/effects carry it through unchanged and
// playback resolves it per frame (resolveBindings).

export interface Binding {
  $expr: ExprNode
}

export const isBinding = (v: unknown): v is Binding =>
  v !== null && typeof v === 'object' && '$expr' in (v as Record<string, unknown>)

// Exported for expr-cell.ts: "=" cells bake with exactly derive()'s semantics.
export function bakeExpr(node: ExprNode, row: Row, i: number): unknown {
  return isStreamingNode(node) ? { $expr: node } : evalExpr(node, row, i)
}

// Returns the same row object when there's nothing to resolve.
export function resolveBindings(row: Row, ctx: EvalCtx): Row {
  let out: Row | null = null
  for (const k in row) {
    const v = row[k]
    if (isBinding(v)) {
      if (!out) out = { ...row }
      out[k] = evalExpr(v.$expr, row, 0, ctx)
    }
  }
  return out ?? row
}

/** A row template: values are Expr (evaluated per row), nested templates, arrays, or literals (functions like easings pass through untouched). */
export type Template = Record<string, unknown>

function buildValue(v: unknown, row: Row, i: number): unknown {
  if (v instanceof Expr) return bakeExpr(v.node, row, i)
  if (Array.isArray(v)) return v.map((x) => buildValue(x, row, i))
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>)) {
      out[k] = buildValue((v as Record<string, unknown>)[k], row, i)
    }
    return out
  }
  return v
}

const buildRow = (tmpl: Template, row: Row, i: number): Row => buildValue(tmpl, row, i) as Row

// Function-bearing specs are seed-sensitive (a closure might call rand), so
// their node's hash must include the run seed.
function hasFn(v: unknown): boolean {
  if (typeof v === 'function') return true
  if (v instanceof Expr) return false
  if (Array.isArray(v)) return v.some(hasFn)
  if (v !== null && typeof v === 'object') return Object.values(v as Record<string, unknown>).some(hasFn)
  return false
}

// ── Canonical serialization + hashing (for the Merkle dataflow) ──────────────

function stableStringify(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undef'
  const t = typeof v
  if (t === 'number' || t === 'boolean') return String(v)
  if (t === 'string') return JSON.stringify(v)
  if (t === 'function') return 'fn:' + (v as () => unknown).toString()
  if (v instanceof Expr) return 'expr:' + stableStringify(v.node)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}'
}

// FNV-1a — exported because it's also the runtime's per-view PRNG seed hash.
export function fnv1a(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// Content hash: op + canonical spec (+ run seed when seed-sensitive) + input
// hashes. Memoized per instance.
export function hashOf(t: Table): number {
  if (t._hash !== null) return t._hash
  const node = t._node
  const childHashes = node.inputs.map(hashOf)
  const seedPart = node.seedSensitive ? '#' + String(t._ctx?.seed ?? 0) : ''
  const canon = node.op + '|' + stableStringify(node.spec) + seedPart + '|' + childHashes.join(',')
  return (t._hash = fnv1a(canon))
}

// ── Materialization ──────────────────────────────────────────────────────────

export interface MatCtx {
  physics?: () => PhysicsEngine | null
}

export interface Memo {
  get(h: number): Row[] | undefined
  set(h: number, rows: Row[]): void
}

// With a `memo`, reuse a previous run's rows when the content hash matches —
// the heart of incremental cooking.
export function materialize(t: Table, ctx: MatCtx, memo?: Memo): Row[] {
  if (t._rows) return t._rows
  let h: number | null = null
  if (memo) {
    h = hashOf(t)
    const hit = memo.get(h)
    if (hit) {
      t._rows = hit
      return hit
    }
  }
  const inputs = t._node.inputs.map((inp) => materialize(inp, ctx, memo))
  const rows = t._node.compute(inputs, ctx)
  t._rows = rows
  if (memo && h !== null) memo.set(h, rows)
  return rows
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GraphSpec {
  table?: Table
  columns: string[]
  viewName?: string | null
  name?: string
}

export interface PhysicsEngine {
  simulate(baseRows: Row[], opts?: SimulateOptions): Row[]
}

export interface SimulateOptions {
  steps?: number
  gravity?: number
  fps?: number
  sampleEvery?: number
  collisions?: boolean
}

// Kept internal so the public ThreeChain methods can inline the option shape —
// hover on rotate/scale/move then shows exactly what can be passed.
interface ThreeAnimOpts {
  amount?: number
  dur?: number
  axis?: 'x' | 'y' | 'z'
  ease?: (t: number) => number
  at?: number
}

/**
 * The .three accessor on a scene table: animators that read the table's
 * `create` rows and append update keyframes carrying each object's transform.
 * Every method returns a Table (base rows plus keyframes), so they chain —
 * t.box().three.rotate().three.scale().rasterize(8).
 */
export interface ThreeChain {
  /** Spin each object by `amount` radians about `axis` (default a full turn about y) over `dur` beats — adds to the current rotation. `at` overrides the start beat; `ease` shapes the segment. */
  rotate(opts?: { amount?: number; dur?: number; axis?: 'x' | 'y' | 'z'; ease?: (t: number) => number; at?: number }): Table
  /** Grow/shrink each object by the `amount` factor (default 2×) over `dur` beats — multiplies the current scale uniformly (sx/sy/sz). */
  scale(opts?: { amount?: number; dur?: number; ease?: (t: number) => number; at?: number }): Table
  /** Slide each object by `amount` world units along `axis` (default 1 along x) over `dur` beats — adds to the current position. */
  move(opts?: { amount?: number; dur?: number; axis?: 'x' | 'y' | 'z'; ease?: (t: number) => number; at?: number }): Table
}

const TAU = Math.PI * 2
const numOr = (v: unknown, d: number): number => (typeof v === 'number' ? v : d)

// Per-field numeric tweaks for the three.* row modifiers: touch a field on
// every base (create/untyped) row, and on update keyframes only when they
// already carry it, so partial animation rows stay intact.
function modRow(r: Row, specs: [key: string, base: number, f: (v: number) => number][]): Row {
  const out: Row = { ...r }
  for (const [key, base, f] of specs) {
    if (key in r || r.event !== 'update') out[key] = f(numOr(r[key], base))
  }
  return out
}

export interface DSLContext {
  defineLazy(name: string, fn: ViewFn, group?: string): void
  defineConst(name: string, table: Table): void
  addGraph(spec: GraphSpec): void
  resolve(name: string): Table
  // .outHydra()/.outThree()/… routing — collects tables per consumer; the
  // runtime combines them into the "(system)" output view (see outViewName).
  addOut?(kind: string, table: Table): void
  physics?: () => PhysicsEngine | null
  // The tap-beat rows — the tempo source for tempo()/beats().
  tapRows?: () => Row[] | null
  // The run seed; folded into seed-sensitive node hashes.
  seed?: number
  // Synchronous lookup for pre-fetched data() URLs.
  getData?(url: string): string
  // Live rows for a user-editable table, creating/reconciling it on first use.
  editableRows?(name: string, schema: Schema, seedRows?: Row[]): Row[]
  // Declare an on-screen slider: expr.slider(name, min, max) adds { name, min,
  // max } to the "sliders" table the first time the name is seen.
  defineSlider?(id: string, min?: number, max?: number): void
}

export type ViewFn = (rand: () => number, table: (name: string) => Table) => Table | Row[]

// Display name of a combined per-consumer output view: every table routed
// with .outHydra()/.outThree()/…, concatenated beat-sorted. When it exists,
// consumers read it INSTEAD of the same-named view — the bare-name lookup is
// only the no-routes backwards-compatibility fallback.
export const outViewName = (kind: string): string => `${kind} (system)`

interface TNode {
  op: string
  spec: unknown
  inputs: Table[]
  compute: (inputs: Row[][], ctx: MatCtx) => Row[]
  seedSensitive: boolean
}

// ── Row helpers ──────────────────────────────────────────────────────────────

const tag = (row: Row, refs: ReturnType<typeof carry>): Row => withLineage({ ...row }, refs)
const recarry = (row: Row): Row => tag(row, carry(row))
const spread = (res: Row | Row[] | null | undefined, refs: ReturnType<typeof carry>): Row[] =>
  res == null ? [] : (Array.isArray(res) ? res : [res]).map((e) => tag(e, refs))
const rowsOf = (x: Table | Row[] | null | undefined): Row[] =>
  x instanceof Table ? x.rows : x ?? []

export class Table {
  name: string | null
  _ctx: DSLContext | null
  _node: TNode
  _rows: Row[] | null
  _hash: number | null

  constructor(rows: Row[] = [], ctx: DSLContext | null = null) {
    this._ctx = ctx
    this.name = null
    this._rows = null
    this._hash = null
    // A literal-rows leaf hashes by value, so rand-derived rows are naturally
    // seed-sensitive without any flag.
    this._node = { op: 'rows', spec: rows, inputs: [], seedSensitive: false, compute: () => rows }
  }

  static _fromNode(ctx: DSLContext | null, node: TNode): Table {
    const t = Object.create(Table.prototype) as Table
    t._ctx = ctx
    t.name = null
    t._rows = null
    t._hash = null
    t._node = node
    return t
  }

  private _xf(
    op: string,
    spec: unknown,
    compute: (inputs: Row[][], ctx: MatCtx) => Row[],
    seedSensitive = false,
    others: Table[] = [],
  ): Table {
    return Table._fromNode(this._ctx, { op, spec, inputs: [this, ...others], compute, seedSensitive })
  }

  private _other(x: Table | Row[] | null | undefined): Table {
    return x instanceof Table ? x : new Table(x ?? [], this._ctx)
  }

  get rows(): Row[] {
    return materialize(this, { physics: this._ctx?.physics })
  }

  get length(): number {
    return this.rows.length
  }

  get columns(): string[] {
    const seen: string[] = []
    const set = new Set<string>()
    for (const row of this.rows) {
      for (const k of Object.keys(row)) {
        if (!set.has(k)) {
          set.add(k)
          seen.push(k)
        }
      }
    }
    return seen
  }

  /** map(fn) transforms each row; map(template) builds each row declaratively from Expr/literals (diffable). Both carry the source row's lineage. */
  map(fn: (r: Row, i: number) => Row): Table
  map(template: Record<string, unknown>): Table
  map(arg: ((r: Row, i: number) => Row) | Record<string, unknown>): Table {
    if (typeof arg === 'function') {
      const fn = arg
      return this._xf('map', { fn }, (ins) => ins[0].map((r, i) => tag(fn(r, i), carry(r))), true)
    }
    const tmpl = arg
    return this._xf('mapT', { tmpl }, (ins) => ins[0].map((r, i) => tag(buildRow(tmpl, r, i), carry(r))), false)
  }

  /**
   * Keep rows that match a { field: value, … } pattern (every field strictly
   * equal, multi-key = AND) or an Expr predicate — filter(field("v").gt(3)).
   * Both forms are data, so the result is diffable and cheap to re-cook.
   */
  filter(pred: Record<string, unknown> | Expr): Table {
    if (pred instanceof Expr) {
      const node = pred.node
      return this._xf('filterE', { pred }, (ins) => ins[0].filter((r, i) => evalExpr(node, r, i)).map(recarry), false)
    }
    if (typeof pred === 'function') {
      throw new Error('filter() takes a { field: value } pattern or an Expr (e.g. field("v").gt(3)), not a function')
    }
    const keys = Object.keys(pred)
    return this._xf('filterMatch', { match: pred }, (ins) =>
      ins[0].filter((r) => keys.every((k) => r[k] === pred[k])).map(recarry), false)
  }

  /** Fan out each row into zero, one, or many rows, like Array.flatMap. For a diffable version use filter(...).emit(template). */
  flatMap(fn: (r: Row, i: number, rows: Row[]) => Row | Row[] | null | undefined): Table {
    return this._xf('flatMap', { fn }, (ins) => ins[0].flatMap((r, i) => spread(fn(r, i, ins[0]), carry(r))), true)
  }

  /** Declarative flatMap: produce one or many rows per source row from Expr/literal templates. Pair with filter() for "when X, emit Y". */
  emit(template: Record<string, unknown> | Record<string, unknown>[]): Table {
    return this._xf('emit', { template }, (ins) =>
      ins[0].flatMap((r, i) => {
        const built = Array.isArray(template)
          ? template.map((tt) => buildRow(tt, r, i))
          : buildRow(template, r, i)
        return spread(built, carry(r))
      }), false)
  }

  concat(other: Table | Row[] | null | undefined): Table {
    return this._xf('concat', {}, (ins) => [...ins[0], ...ins[1]].map(recarry), false, [this._other(other)])
  }

  slice(start: number, end?: number): Table {
    return this._xf('slice', { start, end }, (ins) => ins[0].slice(start, end).map(recarry), false)
  }

  fold<T>(fn: (acc: T, cur: Row, i: number, rows: Row[]) => T, initial: T): T {
    let acc = initial
    const rows = this.rows
    for (let i = 0; i < rows.length; i++) acc = fn(acc, rows[i], i, rows)
    return acc
  }

  scan<S>(
    fn: (state: S, cur: Row, i: number, rows: Row[]) => { state?: S; emit?: Row | Row[] | null | undefined } | null | undefined,
    initialState: S,
  ): Table {
    return this._xf('scan', { fn, initialState }, (ins) => {
      const out: Row[] = []
      let state = initialState
      ins[0].forEach((cur, i) => {
        const res = fn(state, cur, i, ins[0])
        if (res == null) return
        if ('state' in res && res.state !== undefined) state = res.state as S
        out.push(...spread(res.emit, carry(cur)))
      })
      return out
    }, true)
  }

  join(other: Table | Row[], on: string | { left: string; right: string } | ((r: Row) => unknown)): Table {
    const leftOf: (r: Row) => unknown = typeof on === 'function' ? on : (r) => r[typeof on === 'object' ? on.left : on]
    const rightOf: (r: Row) => unknown = typeof on === 'function' ? on : (r) => r[typeof on === 'object' ? on.right : on]
    return this._xf('join', { on }, (ins) => {
      const index = new Map<unknown, Row[]>()
      for (const r of ins[1]) {
        const k = rightOf(r)
        if (!index.has(k)) index.set(k, [])
        index.get(k)!.push(r)
      }
      const out: Row[] = []
      for (const l of ins[0]) {
        for (const r of index.get(leftOf(l)) ?? []) {
          out.push(withLineage({ ...l, ...r }, unionLineage([l, r])))
        }
      }
      return out
    }, typeof on === 'function', [this._other(other)])
  }

  zip(other: Table | Row[]): Table {
    return this._xf('zip', {}, (ins) => {
      const n = Math.min(ins[0].length, ins[1].length)
      const out: Row[] = []
      for (let i = 0; i < n; i++) {
        out.push(withLineage({ ...ins[0][i], ...ins[1][i] }, unionLineage([ins[0][i], ins[1][i]])))
      }
      return out
    }, false, [this._other(other)])
  }

  orderBy(key: string | ((r: Row) => unknown), dir: 'asc' | 'desc' = 'asc'): Table {
    const accessor = typeof key === 'function' ? key : (r: Row) => r[key]
    const sign = dir === 'desc' ? -1 : 1
    return this._xf('orderBy', { key, dir }, (ins) => {
      const sorted = [...ins[0]].sort((a, b) => {
        const av = accessor(a) as string | number, bv = accessor(b) as string | number
        return av < bv ? -sign : av > bv ? sign : 0
      })
      return sorted.map(recarry)
    }, typeof key === 'function')
  }

  /**
   * Add or overwrite fields on every row; each spec value is an Expr, a
   * function (r, i) => val, or a literal. A streaming Expr binds per frame —
   * derive({ py: expr.slider("height") }) follows the slider as the loop
   * replays — while a constant Expr is baked in immediately.
   */
  derive(spec: Record<string, Expr | ((r: Row, i: number) => unknown) | unknown>): Table {
    return this._xf('derive', { spec }, (ins) => ins[0].map((r, i) => {
      const next: Row = { ...r }
      for (const k in spec) {
        const sv = spec[k]
        next[k] = sv instanceof Expr ? bakeExpr(sv.node, r, i)
          : typeof sv === 'function' ? (sv as (r: Row, i: number) => unknown)(r, i)
            : sv
      }
      return withLineage(next, carry(r))
    }), hasFn(spec))
  }

  rescale(src: string, [inLo, inHi]: [number, number], [outLo, outHi]: [number, number], dst: string = src): Table {
    const span = (inHi - inLo) || 1
    return this._xf('rescale', { src, inLo, inHi, outLo, outHi, dst }, (ins) =>
      ins[0].map((r) => {
        const f = ((r[src] as number) - inLo) / span
        return withLineage({ ...r, [dst]: outLo + f * (outHi - outLo) }, carry(r))
      }), false)
  }

  lag(fieldName: string, n: number = 1, as: string = `${fieldName}_lag`): Table {
    return this._xf('lag', { field: fieldName, n, as }, (ins) =>
      ins[0].map((r, i) => withLineage({ ...r, [as]: i >= n ? ins[0][i - n][fieldName] : null }, carry(r))), false)
  }

  groupBy(key: string | ((r: Row) => unknown)): { agg(spec: Record<string, (rows: Row[]) => unknown>): Table; count(as?: string): Table } {
    const keyName = typeof key === 'function' ? 'key' : key
    const accessor = typeof key === 'function' ? key : (r: Row) => r[key]
    const self = this
    const build = (op: string, spec: unknown, aggregate: (groups: Map<unknown, Row[]>) => Row[]): Table =>
      self._xf(op, spec, (ins) => {
        const groups = new Map<unknown, Row[]>()
        for (const r of ins[0]) {
          const k = accessor(r)
          if (!groups.has(k)) groups.set(k, [])
          groups.get(k)!.push(r)
        }
        return aggregate(groups)
      }, true)
    return {
      agg(spec: Record<string, (rows: Row[]) => unknown>): Table {
        return build('groupBy.agg', { key, spec }, (groups) => {
          const out: Row[] = []
          for (const [k, rs] of groups) {
            const row: Row = { [keyName]: k }
            for (const f in spec) row[f] = spec[f](rs)
            out.push(withLineage(row, unionLineage(rs)))
          }
          return out
        })
      },
      count(as: string = 'count'): Table {
        return build('groupBy.count', { key, as }, (groups) => {
          const out: Row[] = []
          for (const [k, rs] of groups) {
            out.push(withLineage({ [keyName]: k, [as]: rs.length }, unionLineage(rs)))
          }
          return out
        })
      },
    }
  }

  triggerEach(
    predicate: (cur: Row, i: number, rows: Row[]) => unknown,
    objects: Table | Row[],
    make: (o: Row, cur: Row, i: number, k: number) => Row | Row[] | null | undefined,
  ): Table {
    return this._xf('triggerEach', { predicate, make }, (ins) =>
      ins[0].flatMap((cur, i) =>
        predicate(cur, i, ins[0])
          ? ins[1].flatMap((o, k) => spread(make(o, cur, i, k), unionLineage([cur, o])))
          : []), true, [this._other(objects)])
  }

  crossings(fieldName: string = 'value', level: number = 0): Table {
    return this._xf('crossings', { field: fieldName, level }, (ins) => {
      const out: Row[] = []
      for (let i = 1; i < ins[0].length; i++) {
        const prev = (ins[0][i - 1][fieldName] as number) - level
        const cur = (ins[0][i][fieldName] as number) - level
        if (prev !== 0 && prev * cur < 0) {
          out.push(withLineage({ ...ins[0][i], dir: cur > 0 ? 1 : -1 }, carry(ins[0][i])))
        }
      }
      return out
    }, false)
  }

  /**
   * Pair up the rows matching a { field: value, … } pattern, cyclically (match
   * 0 pairs with the LAST match); fn(first, second) returns the row(s) that
   * replace `second`. Non-matching rows pass through unchanged.
   */
  pairBy(match: Record<string, unknown>, fn: (first: Row, second: Row) => Row | Row[]): Table {
    const keys = Object.keys(match)
    return this._xf('pairBy', { match, fn }, (ins) => {
      const rows = ins[0]
      const matchIdx: number[] = []
      rows.forEach((r, i) => { if (keys.every((k) => r[k] === match[k])) matchIdx.push(i) })
      if (!matchIdx.length) return rows.map(recarry)
      const replacement = new Map<number, Row[]>()
      matchIdx.forEach((idx, k) => {
        const prev = rows[matchIdx[(k - 1 + matchIdx.length) % matchIdx.length]]
        const cur = rows[idx]
        replacement.set(idx, spread(fn(prev, cur), unionLineage([prev, cur])))
      })
      return rows.flatMap((r, i) => replacement.get(i) ?? [recarry(r)])
    }, true)
  }

  rasterize(maxBeats?: number): Table {
    return this._xf('rasterize', { maxBeats }, (ins) => rasterizeRows(ins[0], maxBeats), false)
  }

  /** Shift every row `beats` later on the beat axis (negative = earlier). Rows without a `beat` are untouched. */
  shift(beats: number): Table {
    return this._xf('shift', { beats }, (ins) => ins[0].map((r) => {
      if (typeof r.beat !== 'number') return recarry(r)
      return withLineage({ ...r, beat: (r.beat as number) + beats }, carry(r))
    }), false)
  }

  /**
   * Warp this table's `beat`s through a timeline table (see schemas.timeline):
   * each row lands at every playback beat its source beat is shown, so a
   * "loop" event (or a repeating "retime" block) duplicates the looped rows
   * once per cycle, a "retime" stretch rescales `dur` along with the
   * spacing, and rows no event plays are dropped. Rows without a numeric
   * `beat` — and every row when the timeline has no events — pass through
   * unchanged. e.g. table("melody").retime(table("warp")).rasterize().
   * An origami folding retimes the same way: warp the beat-keyed fold
   * keyframes of paper.sequence() (keep the spawn row unmapped) to loop or
   * stretch subsections of the folding —
   * paper.spawn().concat(paper.sequence().retime(table("warp"))).
   */
  retime(timeline: Table | Row[] | null | undefined): Table {
    return this._xf('retime', {}, (ins) => {
      const segments = timelineSegments(ins[1])
      if (!segments.length) return ins[0].map(recarry)
      return ins[0].flatMap((r) => {
        if (typeof r.beat !== 'number') return [recarry(r)]
        return placeBeat(segments, r.beat as number).map(({ beat, stretch }) => {
          const next: Row = { ...r, beat }
          if (typeof r.dur === 'number') next.dur = (r.dur as number) * stretch
          return withLineage(next, carry(r))
        })
      })
    }, false, [this._other(timeline)])
  }

  /** Animate this table's scene objects over time — see ThreeChain. */
  get three(): ThreeChain {
    return {
      rotate: (opts: ThreeAnimOpts = {}): Table => {
        const { amount = TAU, axis = 'y' } = opts
        const f = `r${axis}`
        return this._threeAnim('three.rotate', opts, (c) => {
          const from = numOr(c[f], 0)
          return { start: { [f]: from }, end: { [f]: from + amount } }
        })
      },
      move: (opts: ThreeAnimOpts = {}): Table => {
        const { amount = 1, axis = 'x' } = opts
        const f = `p${axis}`
        return this._threeAnim('three.move', opts, (c) => {
          const from = numOr(c[f], 0)
          return { start: { [f]: from }, end: { [f]: from + amount } }
        })
      },
      scale: (opts: ThreeAnimOpts = {}): Table => {
        const { amount = 2 } = opts
        return this._threeAnim('three.scale', opts, (c) => {
          const sx = numOr(c.sx, 1), sy = numOr(c.sy, 1), sz = numOr(c.sz, 1)
          return { start: { sx, sy, sz }, end: { sx: sx * amount, sy: sy * amount, sz: sz * amount } }
        })
      },
    }
  }

  // Shared .three.* machinery: base rows pass through; per create row, append a
  // start + end update keyframe `dur` beats apart (rasterize eases between
  // them). An `ease` function makes the node seed-sensitive, like map(fn).
  private _threeAnim(op: string, opts: ThreeAnimOpts, fieldsFor: (create: Row) => { start: Row; end: Row }): Table {
    const { dur = 4, at, ease } = opts
    return this._xf(op, opts, (ins) => {
      const out: Row[] = ins[0].map(recarry)
      for (const c of ins[0]) {
        if (c.event !== 'create') continue
        const startBeat = at ?? (typeof c.beat === 'number' ? (c.beat as number) : 1)
        const { start, end } = fieldsFor(c)
        out.push(tag({ id: c.id, event: 'update', beat: startBeat, ...start }, carry(c)))
        out.push(tag({ id: c.id, event: 'update', beat: startBeat + dur, ...end, ...(ease ? { ease } : {}) }, carry(c)))
      }
      return out
    }, hasFn(opts))
  }

  graph(...columns: (string | string[])[]): this {
    const cols = columns.flat().filter(Boolean) as string[]
    this._ctx?.addGraph({ table: this, columns: cols })
    return this
  }

  save(name: string): this {
    this.name = name
    this._ctx?.defineConst(name, this)
    return this
  }

  private _out(kind: string): this {
    this._ctx?.addOut?.(kind, this)
    return this
  }

  /**
   * Route this table to the 3D scene: its rows join every other .outThree()
   * table in one combined, beat-sorted "three (system)" table — shown in the
   * table panel and rasterized for playback. No define() or name needed:
   * t.box().three.rotate().outThree(). Routing takes precedence: once
   * anything calls outThree(), ONLY routed tables play — a table named
   * "three" is read only when nothing routes (the backwards-compatibility
   * fallback), so route it too if it should stay in the mix.
   */
  outThree(): this { return this._out('three') }
  /** Route this table of PRE-RASTERIZED per-frame rows to the scene cache, combined with every other .outScene() table — use when you rasterize() yourself; otherwise outThree() and let playback rasterize. Takes precedence over a table named "scene", which is read only when nothing routes. */
  outScene(): this { return this._out('scene') }
  /** Route this table of hydra event rows (schemas.hydra) to the hydra view: combined with every other .outHydra() table into "hydra (system)", which playback reads. Takes precedence: a table named "hydra" is read only when nothing routes — route it too if it should stay in the mix. */
  outHydra(): this { return this._out('hydra') }
  /** Route this table of bauble event rows (schemas.bauble) to the bauble view, combined with every other .outBauble() table. Takes precedence over a table named "bauble", which is read only when nothing routes. */
  outBauble(): this { return this._out('bauble') }
  /** Route this table of post event rows (schemas.post) to the post-processing chain, combined with every other .outPost() table. Takes precedence over a table named "post", which is read only when nothing routes. */
  outPost(): this { return this._out('post') }
  /** Route this table of timeline event rows (schemas.timeline) to the playback timeline, combined with every other .outTimeline() table — e.g. beats(16).outTimeline(). Takes precedence over a table named "timeline", which is read only when nothing routes. */
  outTimeline(): this { return this._out('timeline') }
  /** Route this table of particle event rows (schemas.particles) to the GPU particle sim, combined with every other .outParticles() table. Takes precedence over a table named "particles", which is read only when nothing routes. */
  outParticles(): this { return this._out('particles') }
}

class PhysicsBuilder {
  private _source: Table | Row[]
  private _ctx: DSLContext

  constructor(source: Table | Row[], ctx: DSLContext) {
    this._source = source
    this._ctx = ctx
  }

  simulate(opts: { steps?: number; gravity?: number; fps?: number; sampleEvery?: number; collisions?: boolean } = {}): Table {
    const src = this._source instanceof Table ? this._source : new Table(this._source ?? [], this._ctx)
    return Table._fromNode(this._ctx, {
      op: 'physics',
      spec: opts,
      inputs: [src],
      seedSensitive: false,
      compute: (ins, ctx): Row[] => {
        const engine = ctx.physics?.()
        if (!engine) {
          throw new Error('physics engine still loading — press Run again in a moment')
        }
        return engine.simulate(ins[0], opts)
      },
    })
  }
}

// ── Origami ───────────────────────────────────────────────────────────────────
// A sheet of paper folded by a table of fold steps (row fields: schemas.origami).
// Each row is solved exactly — a row that cannot fold flat is an error naming
// the step, not a silently dead fold. Playback drives one numeric field,
// `fold`: k means the first k folds have landed; fractional values swing the
// next flap through 3D about its fold line.

export class OrigamiBuilder {
  private _size: number
  private _ctx: DSLContext | null
  private _id: unknown = 'paper'
  private _rows: Row[] = []
  private _compiled: FoldTableProgram | null = null

  constructor(size: number, ctx: DSLContext | null) {
    this._size = size
    this._ctx = ctx
  }

  /** Fold the sheet: one row per fold (see schemas.origami for the columns), applied in order. */
  steps(steps: Table | Row[]): OrigamiBuilder {
    const next = new OrigamiBuilder(this._size, this._ctx)
    next._id = this._id
    next._rows = [...this._rows, ...rowsOf(steps)]
    return next
  }

  program(): FoldTableProgram {
    if (!this._compiled) {
      this._compiled = compileFoldTable(this._rows, { size: this._size })
    }
    return this._compiled
  }

  /** The create row: compiled program + fold at 0 (flat sheet). Extra props (id, color, px/py/pz, …) merge over defaults. */
  spawn(props: Row = {}): Table {
    const program = this.program()
    this._id = props.id ?? this._id
    // Turn-overs rotate about the axis the VIEWER sees as vertical: the scene
    // rotates the whole object by rz, so undo it here.
    const rz = typeof props.rz === 'number' ? props.rz : 0
    program.flipAxis = [Math.sin(rz), Math.cos(rz)]
    return new Table([{
      id: this._id, event: 'create', beat: 1, shape: 'origami',
      px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, color: 0xd94f2a,
      fold: 0, program, ...props,
    }], this._ctx)
  }

  /**
   * Fold schedule → update keyframes driving `fold`. With no argument, uses
   * the beat/dur timings from the steps() rows; override with rows
   * { step?, beat, dur? } to retime.
   */
  sequence(steps?: Table | Row[] | null, opts: { id?: unknown } = {}): Table {
    const id = opts.id ?? this._id
    const program = this.program()
    let timed = program.steps.map((s) => ({ t0: s.t0, t1: s.t1, to: s.to, name: s.name }))
    const overrides = steps instanceof Table ? steps.rows : steps
    if (overrides) {
      const byName = new Map(timed.map((s) => [s.name, s]))
      overrides.forEach((r, i) => {
        const target = r.step != null ? byName.get(String(r.step)) : timed[i]
        if (!target) return
        const at = r.beat
        if (at != null) {
          const dur = r.dur != null ? Math.max(Number(r.dur), 1 / FRAMES_PER_BEAT) : target.t1 - target.t0
          target.t0 = Number(at)
          target.t1 = Number(at) + dur
        }
      })
      timed = [...timed].sort((a, b) => a.t0 - b.t0)
    }
    const out: Row[] = []
    timed.forEach((s, k) => {
      out.push({ id, event: 'update', beat: s.t0, fold: k })
      out.push({ id, event: 'update', beat: s.t1, fold: k + s.to })
    })
    return new Table(out, this._ctx)
  }

  /** The fold value at a beat under the table's own schedule. */
  foldAt(beat: number): number {
    return foldValueAt(this.program(), beat)
  }
}

export interface OrigamiFactory {
  /** A bare square sheet (displayed spanning [-size, size]², default size 1) — fold it with .steps(table). */
  (opts?: { size?: number }): OrigamiBuilder
}

function makeOrigami(ctx: DSLContext | null): OrigamiFactory {
  return ((opts: { size?: number } = {}) =>
    new OrigamiBuilder(opts.size ?? 1, ctx)) as OrigamiFactory
}

class MathBuilder {
  private _fn: (t: number) => number
  private _ctx: DSLContext

  constructor(fn: (t: number) => number, ctx: DSLContext) {
    this._fn = fn
    this._ctx = ctx
  }

  /** Sample over `beats` beats, one row per frame; `t` passed to the fn is elapsed beats (0 at the first row). Eager, so rand-derived values hash by value. */
  range(beats: number): Table {
    const n = Math.max(1, Math.round(beats * FRAMES_PER_BEAT))
    const rows: Row[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const t = i / FRAMES_PER_BEAT
      rows[i] = { beat: t + 1, value: this._fn(t) }
    }
    return new Table(rows, this._ctx)
  }
}

export const EASINGS = {
  linear: (t: number): number => t,
  easeIn: (t: number): number => t * t,
  easeOut: (t: number): number => 1 - (1 - t) * (1 - t),
  easeInOut: (t: number): number => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2),
} as const

export type Easings = typeof EASINGS

// Canonical schemas for the tables the runtime knows by name (surfaced to the
// editor as `schemas` — its JSDoc there carries the usage docs). A column's
// `usedBy` lists the events/types that give it effect, so the table panel can
// grey out cells a row's event ignores; a column without it is always live.
export const SCHEMAS = deepFreeze({
  /**
   * The hydra view's event stream: one row per event, placed on the loop by
   * `beat` (1-indexed; a beat past the loop's end — the "beats" control under
   * the scene — lands the event in a later pass of the loop, so beat 17 of a
   * 16-beat loop opens the second pass). `event` picks what it does — "setCode" (`code` = the
   * whole sketch), "setVariable" (`name`/`value` = a live input the sketch
   * reads as a props function), "setSource"/"append" (`code` = a new chain
   * head / a ".effect(…)" fragment), "replace" (swap substring `find` for
   * `value`), "layer" (`code` = another sketch composited via `mode`, amount
   * `value`), "transition" (`code` = a black-and-white mask that wipes to the
   * NEXT setCode ahead — the wipe runs from this beat until that setCode's beat,
   * so you place the destination where the wipe should END; with the
   * destination on the transition's own beat it fills one whole loop pass).
   * `out` names the hydra output the row
   * drives (o0 by default) and is appended as the terminal `.out(oN)`, so a
   * setCode's `code` needn't write its own; each output's events fold
   * independently. `event`, `mode`, and `out` are enums (dropdowns in the table
   * panel); `code` cells open in the editor with hydra completions; check
   * `disabled` to mute a row without deleting it.
   */
  hydra: {
    beat: 'number',
    event: ['setCode', 'setSource', 'append', 'replace', 'layer', 'transition', 'setVariable'],
    out: ['o0', 'o1', 'o2', 'o3'],
    code: { type: 'code', language: 'hydra', usedBy: ['setCode', 'setSource', 'append', 'layer', 'transition'] },
    find: { type: 'string', usedBy: ['replace'] },
    name: { type: 'string', usedBy: ['setVariable'] },
    value: { type: 'number', usedBy: ['setVariable', 'replace', 'layer'] },
    mode: { type: 'enum', options: ['blend', 'add', 'mult', 'diff', 'layer', 'mask'], usedBy: ['layer'] },
    disabled: 'boolean',
  },
  /**
   * The post view's event stream: TSL post-processing built like a hydra table,
   * one row per event placed on the loop by `beat` (1-indexed; a beat past the
   * loop's end lands the event in a later pass). The chain runs on the rendered
   * Three.js scene BEFORE hydra samples it as s0, so it composes with (rather
   * than replaces) the hydra view. The scene is the IMPLICIT source and there is
   * one output, so `code` cells read like hydra — `edges((p) => p.th,
   * 1).bloom((p) => p.glow)` is a complete program (no head, no routing, no
   * `.out()`). Fluent ops include `edges(threshold, colorMode)`, `blur(radius)`,
   * `bloom(strength, radius, threshold)`, `pixelate(size)`, `posterize`,
   * `mosaic`, `rgbshift`, `strobe`, `film`, plus combines `blend`/`add`/`mult`/
   * `diff`/`mask`/`layer` whose argument is another chain — `prev()` (the
   * previous output frame, for feedback), `scene()` (the raw scene), or a
   * generator: `gradient(angle)` (a 0→1 luminance ramp), `noise(scale)` (a
   * dissolve field), `stripes(count, angle)` (blinds), reshaped by
   * `.thresh(edge, softness)` (a moving wipe edge — ride `edge` on
   * `progress().oneSub()`) and `.polar(cx, cy)` (resample in radius/angle, turning
   * a gradient into an iris or clock). Every op argument is either LIVE (the default: a number, or a
   * function of the props object like `(p) => p.glow`, bound to a uniform
   * rebound each frame with no recompile) or STRUCTURAL (e.g. edges' colorMode,
   * which selects a shader path). `slider("name", min?, max?)` is a live arg
   * that reads an on-screen slider each frame — and declares it (one row in
   * the "sliders" table per name) so the control just appears. `val("name",
   * value)` likewise reads a live variable — and materializes its "setVariable"
   * row right after the cell, so the value becomes editable, tweenable table
   * data (deleting the val() call deletes the row). `progress()` is a live arg
   * usable inside a transition's mask chain, reading that transition's window
   * fraction (0 at its beat → 1 at the destination, shaped by the row's `ease`);
   * elsewhere it reads 1. Any live-arg handle (progress/slider/val) carries
   * `.oneSub()` — the 1 − value reflection, e.g. progress().oneSub(). `event` picks what a row
   * does — "setCode"
   * (`code` = the whole chain; empty = passthrough), "add" (append effects,
   * `pixelate(6)`, leading `.` optional), "remove" (`name` = op name; drop every
   * op with that name — the beat-time bypass), "setVariable" (`name`/`value` = a
   * live input the chain reads through a props function; rows of one `name` form
   * a KEYFRAME TRACK ordered by beat, and the row's `ease` shapes the segment
   * INTO it — blank ease STEPS, jumping to `value` on the beat (the default,
   * `dur` is ignored), a named ease (linear/easeIn/easeOut/easeInOut) GLIDES from
   * the previous keyframe's value, arriving exactly ON this beat; repeat a value
   * in the next row to HOLD then ramp, and in a loop a named-ease FIRST keyframe
   * glides across the loop boundary from the last), "pulse" (add `value·env` over
   * `dur` beats — default 1 — `ease` shaping the envelope decay, or 'step' for a
   * square GATE that holds the full value across the window then drops; pulses
   * stack), "layer" (composite another chain via `mode`, amount `value`), and
   * "transition" (composite to the NEXT setCode ahead, per pixel by a black→white
   * mask — `code` is that mask chain, running from this beat until that setCode's
   * beat; black keeps the old chain, white shows the new. It moves ONLY through a
   * mask reading `progress()` (0 at this beat → 1 at the destination, shaped by
   * `ease`): `progress()` alone crossfades, `gradient(0).thresh(progress().oneSub())`
   * wipes, `gradient(Math.PI).polar().thresh(progress().oneSub())` irises — `.oneSub()`
   * (1 − value, on any live arg) flips the mask so the reveal GROWS as progress
   * runs; a bare number like `0.5` is a static half-blend. Blank `code` is static
   * black — the old chain HOLDS the whole window, then cuts to the new one at that
   * setCode).
   * `event`, `ease`, and `mode` are enums (dropdowns); `code` cells open in the
   * editor with post completions; check `disabled` to mute a row.
   */
  post: {
    beat: 'number',
    event: ['setCode', 'add', 'remove', 'layer', 'transition', 'setVariable', 'pulse'],
    code: { type: 'code', language: 'post', usedBy: ['setCode', 'add', 'layer', 'transition'] },
    name: { type: 'string', usedBy: ['setVariable', 'remove', 'pulse'] },
    value: { type: 'number', usedBy: ['setVariable', 'pulse', 'layer'] },
    dur: { type: 'number', usedBy: ['pulse'] },
    ease: { type: 'enum', options: ['step', 'linear', 'easeIn', 'easeOut', 'easeInOut'], usedBy: ['setVariable', 'pulse', 'transition'] },
    mode: { type: 'enum', options: ['blend', 'add', 'mult', 'diff', 'mask'], usedBy: ['layer'] },
    disabled: 'boolean',
  },
  /**
   * The 3D scene's event table (the "three" view): sparse object events keyed
   * by `id`, expanded by rasterize() into per-frame rows. `beat` places the
   * event (1-indexed; a beat past the loop's end lands it in a later pass).
   * `event` picks what it does — "create" (the object appears: set `shape` and
   * any transform fields), "update" (a keyframe: each field it carries is a
   * per-field track easing from the previous keyframe carrying that field),
   * "color" (a color pulse: a bare event hard-switches `color`, newest wins,
   * while a `dur` decays back over `ease` — add a `to` column to aim the decay
   * at a target color instead of the object's base), "destroy" (the object
   * leaves). px/py/pz position, rx/ry/rz rotation in radians, sx/sy/sz scale,
   * `color` a 0xRRGGBB number. `ease` names the easing of the segment INTO this
   * keyframe — blank stays linear (motion's default), while 'step' makes it a
   * HOLD keyframe: the field keeps the previous keyframe's value until this
   * beat, then jumps. Number cells accept "=" expressions (e.g. "=slider('h')"
   * or "=progress().mul(6.283).sin()"), which hold streaming over their span
   * instead of interpolating; `dur` (beats) sets the window a value's
   * progress() sweeps — without it, an expression runs to the next keyframe
   * carrying the same field. Check `disabled` to mute a row without deleting it.
   */
  scene: {
    beat: 'number',
    id: 'string',
    event: ['create', 'update', 'color', 'destroy'],
    shape: { type: 'enum', options: ['box', 'sphere', 'cylinder', 'cone', 'torus', 'text', 'light', 'camera'], usedBy: ['create'] },
    px: { type: 'number', usedBy: ['create', 'update'] },
    py: { type: 'number', usedBy: ['create', 'update'] },
    pz: { type: 'number', usedBy: ['create', 'update'] },
    rx: { type: 'number', usedBy: ['create', 'update'] },
    ry: { type: 'number', usedBy: ['create', 'update'] },
    rz: { type: 'number', usedBy: ['create', 'update'] },
    sx: { type: 'number', usedBy: ['create', 'update'] },
    sy: { type: 'number', usedBy: ['create', 'update'] },
    sz: { type: 'number', usedBy: ['create', 'update'] },
    color: { type: 'number', usedBy: ['create', 'update', 'color'] },
    dur: { type: 'number', usedBy: ['update', 'color'] },
    ease: { type: 'enum', options: ['step', 'linear', 'easeIn', 'easeOut', 'easeInOut'], usedBy: ['update', 'color'] },
    disabled: 'boolean',
  },
  /**
   * The GPU particle view: a table that opts the curl-noise particle sim in
   * and drives its parameters. A "spawn" row turns the sim on — without one
   * it never runs (WebGPU browsers only; the WebGL2 fallback has no compute
   * shaders, so the rest of the scene renders without particles). "setVariable"
   * rows drive the sim's parameters, folded at-or-before the playhead like every
   * event table: `name` is one of "timeMultiplier" (how fast the noise field
   * evolves), "elscale" (spatial scale of the swirls), or "speed"
   * (per-particle speed along the field); `value` the number. A slider named
   * "particles" (if defined) rides on top as a live speed override. The sim
   * itself is stateful GPU compute — it can't be baked or scrubbed exactly;
   * only these controls replay. Check `disabled` to mute a row.
   */
  particles: {
    beat: 'number',
    event: ['spawn', 'setVariable'],
    name: { type: 'string', usedBy: ['setVariable'] },
    value: { type: 'number', usedBy: ['setVariable'] },
    disabled: 'boolean',
  },
  /**
   * The bauble view's event stream: one row per event, placed on the loop by
   * `beat` (1-indexed; like hydra, a beat past the loop's end lands the event
   * in a later pass of the loop) — the same table-of-events format as hydra,
   * for 3D SDF sketches instead of 2D post-processing. `event` picks what it does —
   * "setCode" (`code` = the whole sketch, a Janet shape expression like
   * "(rotate (box 50) :y t)"), "setVariable" (`name`/`value` = a (def name
   * value) compiled ahead of the sketch; changing one recompiles the shader,
   * except the reserved camera-x/camera-y/camera-zoom names, which orbit the
   * camera as live uniforms) — plus the meta-programming events that rewrite
   * the accumulated code in place: "transform" (`code` = a form wrapped
   * around the shape, a standalone `_` marking the hole or the shape inserted
   * as first argument), "duplicate" (combine the shape with a copy of itself
   * run through `code`, via `mode` + smoothing `value`), "combine" (`code` =
   * another whole shape composited via `mode` — union/intersect/subtract take
   * `value` as the :r blend radius, morph as its blend amount), "replace"
   * (swap substring `find` for `value`), "slice" (cut the shape open: an
   * onion shell `value` thick minus `code` — or a half-space about `axis`),
   * "tile" (repeat on an infinite lattice — `value` spaces all axes, or a
   * string vec3 like "[80 120 80]"), "radial" (`value` copies in a circle
   * about `axis`), and "transition" (morph from the program so far to the NEXT
   * setCode ahead, riding the playback clock — the morph runs from this beat
   * until that setCode's beat, so its beat sets the length). The render shows
   * directly when no hydra sketch is live, and is hydra's s1 source either
   * way — composite it with src(s1). `code` cells open in the editor as
   * Janet (no JS completions); check `disabled` to mute a row without
   * deleting it.
   */
  bauble: {
    beat: 'number',
    event: ['setCode', 'transform', 'duplicate', 'combine', 'replace', 'slice', 'tile', 'radial', 'transition', 'setVariable'],
    code: { type: 'code', language: 'bauble', usedBy: ['setCode', 'transform', 'duplicate', 'combine', 'slice'] },
    find: { type: 'string', usedBy: ['replace'] },
    name: { type: 'string', usedBy: ['setVariable'] },
    value: { type: 'number', usedBy: ['setVariable', 'duplicate', 'combine', 'replace', 'slice', 'tile', 'radial'] },
    mode: { type: 'enum', options: ['union', 'intersect', 'subtract', 'morph'], usedBy: ['duplicate', 'combine'] },
    axis: { type: 'enum', options: ['x', 'y', 'z'], usedBy: ['slice', 'radial'] },
    disabled: 'boolean',
  },
  /**
   * The "timeline" view: an OPTIONAL warp of playback time over the baked
   * content — one event per row, each covering an UNTIL-NEXT window. Rows are
   * ordered by (loop, beat); a row's window runs from its own `beat`
   * (1-indexed, like every other table) to the next row's, so there are never
   * gaps or overlaps — the LAST row runs to the end of its pass, and the pass
   * length is the GUI "beats" control, NOT the timeline's own extent. `event`
   * picks the warp: "retime" (the general one — beats(count, { fit }) emits a
   * single retime) stretches input source beats `from`..`to` into the output
   * block `outFrom`..`outTo` (from > to runs backwards) and repeats the block
   * until the window closes; "pingpong" is a retime whose block plays
   * `from`..`to` there and back (out 5..9 from 1..4 swings forward then
   * backward, each leg double-time); "loop" cycles source `from`..`to` at
   * natural speed (a retime whose output block is as long as its input);
   * "hold" freezes the frame at `from`; "speed" runs from `from` at `rate`
   * source beats per playback beat. `from`/`to` and `outFrom`/`outTo` default
   * to the window's own start/end, so a bare retime plays straight through —
   * author a hold or a plain stretch of unwarped time as an explicit bare
   * retime row, which is that identity warp. A blank/0 cell means "unset"
   * (beats are 1-indexed). Playback beats BEFORE the first row play unmapped
   * (identity). An optional 0-indexed `loop` column places a row in a later
   * pass. The same table warps any beat table via .retime(table("timeline"));
   * check `disabled` to mute a row (its window falls to its neighbors).
   */
  timeline: {
    beat: 'number',
    event: ['retime', 'pingpong', 'loop', 'hold', 'speed'],
    from: { type: 'number', usedBy: ['retime', 'pingpong', 'loop', 'hold', 'speed'] },
    to: { type: 'number', usedBy: ['retime', 'pingpong', 'loop'] },
    outFrom: { type: 'number', usedBy: ['retime', 'pingpong'] },
    outTo: { type: 'number', usedBy: ['retime', 'pingpong'] },
    rate: { type: 'number', usedBy: ['speed'] },
    loop: 'number',
    disabled: 'boolean',
  },
  /**
   * The "sliders" view: one on-screen control per row — `name` labels it (and
   * is what expr.slider("name") reads), `min`/`max` its range, `default` its
   * initial value. Rows are usually declared by just calling
   * expr.slider("name", min, max) (or a post cell's slider("name", min, max)).
   * Check `disabled` to pull the control off screen without losing its settings.
   */
  sliders: { name: 'string', min: 'number', max: 'number', default: 'number', disabled: 'boolean' },
  /**
   * Beat-timed positions: one keyframe per row — `beat` places it on the loop
   * (1-indexed), `px`/`py`/`pz` the position. The usual shape for an editable
   * motion path; check `disabled` to skip a keyframe.
   */
  path: { beat: 'number', px: 'number', py: 'number', pz: 'number', disabled: 'boolean' },
  /**
   * An origami fold table (see origami().steps()): one fold per row — `step`
   * a label, `p1`/`p2` two points "x,y" on the fold line, `move` the sheet
   * point(s) naming the flap(s) that swing, `kind`/`pick` choose among valid
   * layer orders ("simple", "reverse", "sink", …), `beat`/`dur` the swing's
   * timing (1-indexed, like every other table), `to` how far it lands
   * (1 = flat). Check `disabled` to skip a fold.
   */
  origami: {
    step: 'string', p1: 'string', p2: 'string', move: 'string',
    kind: 'string', pick: 'number', beat: 'number', dur: 'number', to: 'number',
    disabled: 'boolean',
  },
} as const satisfies Record<string, Schema>)

export type Schemas = typeof SCHEMAS

// User programs are untyped JS, so `as const` alone can't stop a sketch from
// assigning into a shared schema and quietly reshaping every later run's
// tables — freeze the whole tree.
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

// One default "create" row for a 3D scene object — the shared implementation
// behind box()/sphere()/… (usage docs live on the DSLSurface members).
function sceneObject(shape: string, props: Row, ctx: DSLContext | null): Table {
  return new Table([{
    id: shape, event: 'create', beat: 1, shape,
    px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0,
    ...props,
  }], ctx)
}

function parseCSV(text: string): Row[] {
  const lines = String(text).trim().split(/\r?\n/).filter((l) => l.length)
  if (!lines.length) return []
  const header = lines[0].split(',').map((h) => h.trim())
  return lines.slice(1).map((line) => {
    const cells = line.split(',')
    const row: Row = {}
    header.forEach((h, i) => {
      const raw = (cells[i] ?? '').trim()
      const num = Number(raw)
      row[h] = raw !== '' && !Number.isNaN(num) ? num : raw
    })
    return row
  })
}

/**
 * The three.js helper namespace, reachable as either `three` or the shorthand
 * `t`. Scene-primitive builders (box, sphere, …) each return a one-row Table
 * you concat into a scene and rasterize; the transform modifiers
 * (translate/scale/rotate) shift a scene table's create rows in place. The
 * JSDoc on each member IS the editor hover doc — write it for the livecoder.
 */
export interface ThreeNamespace {
  /** One "create" row for a box (beat 1, origin, id defaults to the shape name) — set only the fields you care about, then concat into a scene and rasterize. Size: hx/hy/hz half-extents. */
  box(props?: Row): Table
  /** One "create" row for a sphere (beat 1, origin, id defaults to the shape name). Size: r. */
  sphere(props?: Row): Table
  /** One "create" row for a cylinder (beat 1, origin, id defaults to the shape name). Size: r + h (half-height). */
  cylinder(props?: Row): Table
  /** One "create" row for a cone (beat 1, origin, id defaults to the shape name). Size: r + h (half-height). */
  cone(props?: Row): Table
  /** One "create" row for a torus (beat 1, origin, id defaults to the shape name). Size: r. */
  torus(props?: Row): Table
  /** One "create" row of extruded 3D text (beat 1, origin, id defaults to "text"). Fields: text + size (cap height per line). */
  text(props?: Row): Table
  /**
   * One "create" row for a light (shape "light", beat 1, id defaults to
   * "light") — no mesh, it adds a three.js light. `kind` picks the type:
   * "ambient" (flat fill), "hemisphere" (sky/ground fill, `groundColor` the
   * lower tint), "directional" (the default — a sun; px/py/pz the direction it
   * comes from, tx/ty/tz the target), "point" (an omni bulb at px/py/pz,
   * `distance`/`decay` falloff), or "spot" (a cone px/py/pz → tx/ty/tz,
   * `angle`/`penumbra` shape). `color` and `intensity` apply to all. Adding any
   * light switches the scene's default lights off. Concat into a scene and
   * rasterize — intensity/position/color are numeric keyframe tracks, so they
   * animate on the beat timeline like any other field.
   */
  light(props?: Row): Table
  /** The generic form behind box()/sphere()/… — a create row for any shape string, including shapes without a named helper. */
  object(shape: string, props?: Row): Table
  /**
   * A three.js primitive → a table of its points: one row per vertex
   * { i, px, py, pz, nx, ny, nz } (position + surface normal in local space),
   * tessellating the same geometry the renderer draws, sized by the same
   * hx/hy/hz | r | h fields. Pass `segments` for a denser cloud. Plain
   * numbers, so the rows chain like any table.
   */
  points(shape: string, props?: Row): Table
  /** A table of points → a BufferGeometry, reading position (and normal, when every row has nx/ny/nz) from px/py/pz (nx/ny/nz). The inverse of points(). */
  geometry(points: Table | Row[]): BufferGeometry
  /**
   * Camera moves as beat-timed keyframes: one row per keyframe
   * { beat?, px, py, pz, tx, ty, tz, fov? }. px/py/pz place the eye, tx/ty/tz
   * the look-at target (default origin), fov the vertical field of view in
   * degrees. The first row becomes the camera's create row, the rest updates,
   * so it rides events → rasterize and interpolates like any object — concat
   * it into your "three" table, then rasterize.
   */
  camera(keyframes: Row[] | null | undefined): Table
  /**
   * Shift every scene object in `table` by (x, y, z) world units — adds to
   * px/py/pz on each create row (and any keyframe that already carries a
   * position). Chain it before .three animators or .rasterize().
   */
  translate(table: Table | Row[], x?: number, y?: number, z?: number): Table
  /**
   * Scale every scene object in `table` — multiplies its scale (sx/sy/sz,
   * default 1) by (x, y, z). Pass one number for a uniform scale
   * (t.scale(box(), 2)); omit y/z to reuse x on those axes.
   */
  scale(table: Table | Row[], x?: number, y?: number, z?: number): Table
  /**
   * Rotate every scene object in `table` by (x, y, z) radians — adds to
   * rx/ry/rz on each create row. For a spin over time use .three.rotate.
   */
  rotate(table: Table | Row[], x?: number, y?: number, z?: number): Table
}

/**
 * The Expr helpers, grouped like `three`: sources for building serializable,
 * chainable expressions over a row. expr.field/lit/idx read the row itself;
 * expr.midi/slider/time are LIVE — they read a streaming source at the
 * playhead each frame, so a field derived from one follows the note, slider,
 * or clock as the loop replays. Math chains onto any Expr (.sin(), .abs(),
 * .clamp(lo, hi), .pow(e), …) and the multi-argument forms live here
 * (expr.min/max/lerp/clamp/…), with pi/tau/e as constants. The JSDoc on each
 * member IS the editor hover doc — write it for the livecoder.
 */
export interface ExprNamespace {
  /** A chainable expression reading row[name] — expr.field("v").add(1).gt(2). Use in filter(expr), map(template), emit(template), derive: these are diffable (no opaque closures). */
  field(name: string): Expr
  /** A constant expression. Usually you can pass a raw value directly to an Expr method instead. */
  lit(v: number | string | boolean | null): Expr
  /** An expression yielding the row index (0-based). */
  idx(): Expr
  /** A live MIDI value at the playhead, e.g. expr.midi("c4") — the most recent event for the note (or "cc1" for control change) at-or-before the playhead, normalized 0–1. Chainable like any Expr: expr.midi("c4").mul(2). Resolves each frame, so notes played while looping replay at the loop position they were heard. Optional 1-based `channel` filters to one channel. */
  midi(note: string, channel?: number | null): Expr
  /**
   * A live on-screen slider value, e.g. expr.slider("brightness", 0, 2).
   * Calling it also DECLARES the slider: every run logs the declaration and
   * the "sliders" table keeps one row per name, the latest declaration
   * winning min/max (default 0–1) — so the labelled control appears over the
   * visual with no other setup, and editing the call's range updates it.
   * Several pieces of code can read the same slider (give them all the same
   * min/max). Each control records its automation the way MIDI does.
   */
  slider(id: string, min?: number, max?: number): Expr
  /** The playback clock in seconds at the playhead — the same clock hydra/post chains see as props.time, so pausing or scrubbing the timeline freezes or scrubs it. Live: resolves each frame, e.g. derive({ ry: expr.time().mul(0.5) }). */
  time(): Expr
  /**
   * Percent-done of the enclosing event, 0→1. A post `setVariable` value sweeps
   * its keyframe's REIGN — from this beat to the next row of the same variable
   * (across the loop boundary when looping); a post `pulse` value its `dur`
   * window; a scene
   * keyframe value reads its own `dur` if set, else its per-field segment —
   * from this keyframe to the next one carrying the same field. Resolved
   * where the row's timing is known, so it works in "=" cells and in
   * code-created exprs (derive({ py: expr.progress() }) on a keyframe)
   * alike; outside any event window it reads 1.
   * e.g. "=progress().mul(expr.tau).sin()" shapes a setVariable's own sweep.
   */
  progress(): Expr
  /** The smaller of `a` and `b` — expr.min(expr.slider("a"), 1). Also chainable: a.min(b). */
  min(a: Expr | number, b: Expr | number): Expr
  /** The larger of `a` and `b`. Also chainable: a.max(b). */
  max(a: Expr | number, b: Expr | number): Expr
  /** `x` raised to the power `e` — expr.pow(field("v"), 2). Also chainable: x.pow(e). */
  pow(x: Expr | number, e: Expr | number): Expr
  /** Angle of the vector (y, x) in radians. Also chainable: y.atan2(x). */
  atan2(y: Expr | number, x: Expr | number): Expr
  /** Limit `x` into [lo, hi]. Also chainable: x.clamp(lo, hi). */
  clamp(x: Expr | number, lo: Expr | number, hi: Expr | number): Expr
  /** Blend from `a` toward `b` by `t` (0–1) — expr.lerp(0, 10, expr.progress()). Also chainable: a.lerp(b, t). */
  lerp(a: Expr | number, b: Expr | number, t: Expr | number): Expr
  /** Wrap `x` into [lo, hi) — expr.wrap(expr.time(), 0, expr.tau). Also chainable: x.wrap(lo, hi). */
  wrap(x: Expr | number, lo: Expr | number, hi: Expr | number): Expr
  /** π as an expression constant — expr.pi.div(2). */
  readonly pi: Expr
  /** 2π, a full turn in radians — progress().mul(expr.tau).sin() completes one cycle over the event. */
  readonly tau: Expr
  /** Euler's number as an expression constant. */
  readonly e: Expr
}

// The one ExprNamespace builder — createDSL's `expr`, the "=" cell scope, and
// the post cell scope (expr-cell.ts) share it, so cells and code see the same
// surface; only slider() differs by ctx (a null ctx reads without declaring).
export function makeExprNamespace(ctx: Pick<DSLContext, 'defineSlider'> | null): ExprNamespace {
  return {
    field, lit, idx, midi, time, progress,
    slider: (id: string, min?: number, max?: number): Expr => {
      ctx?.defineSlider?.(String(id), min, max)
      return slider(id)
    },
    min: (a, b) => callExpr('min', [a, b]),
    max: (a, b) => callExpr('max', [a, b]),
    pow: (x, e) => callExpr('pow', [x, e]),
    atan2: (y, x) => callExpr('atan2', [y, x]),
    clamp: (x, lo, hi) => callExpr('clamp', [x, lo, hi]),
    lerp: (a, b, t) => callExpr('lerp', [a, b, t]),
    wrap: (x, lo, hi) => callExpr('wrap', [x, lo, hi]),
    pi: lit(Math.PI),
    tau: lit(Math.PI * 2),
    e: lit(Math.E),
  }
}

// The globals a user program sees. JSDoc on these members IS the editor's
// hover documentation (gen-lang-env.js copies it onto the generated ambient
// globals), so it is deliberately fuller than the types alone — write it for
// the livecoder.
export type DSLSurface = Easings & {
  define(name: string, fn: ViewFn): void
  define(name: string, group: string, fn: ViewFn): void
  /**
   * table("name") reads a named table (inside a view fn, prefer the fn's own
   * `table` argument so the dependency is tracked). table("name", rows|Table)
   * NAMES a table — the define-free way to register one: table("melody",
   * [{ beat: 1, note: 60 }]); table("name", (rand, table) => …) is define()
   * by another spelling. table() — or table([rows]) — is an ephemeral,
   * unnamed table: chain it and route it with .outHydra()/.outThree()/….
   */
  table(name: string): Table
  table(name: string, source: Table | Row[]): Table
  table(name: string, fn: ViewFn): void
  table(rows?: Row[]): Table
  math(fn: (t: number) => number): MathBuilder
  rows(arr: Row[] | null | undefined): Table
  /**
   * One row per entry in `values`, cycling through `rows` as it goes: output
   * row i is { ...rows[i % rows.length], ...values[i] } — a short repeating
   * base pattern with a longer array of overrides merged on top.
   */
  rotate(rows: Row[] | null | undefined, values: Row[] | null | undefined): Table
  csv(text: string): Table
  data(url: string): Table
  json(data: Row[] | string | unknown): Table
  grid(cols: number, rowsN: number, opts?: { spacing?: number; y?: number }): Table
  /**
   * The three.js helpers, grouped: scene-primitive create rows (box, sphere,
   * cylinder, cone, torus, text, light, and the generic object), the points ⇄
   * geometry samplers, the camera keyframer, and the translate/scale/rotate
   * modifiers that shift a scene table's create rows. Call as three.box(…) —
   * or via the shorthand `t`: t.box(…).
   */
  three: ThreeNamespace
  /** Shorthand alias for `three`: t.box(…), t.translate(scene, 1, 0, 0), etc. */
  t: ThreeNamespace
  physics(source: Table | Row[]): PhysicsBuilder
  /**
   * Folding paper: origami() is a bare sheet. Chain .steps(table) to fold it
   * by instructions (one fold per row — see schemas.origami), then
   * .spawn({ id, color, … }) for the create row and .sequence() for beat-timed
   * fold keyframes.
   */
  origami: OrigamiFactory
  /**
   * A user-editable table: rows are entered/edited in the table panel (not
   * computed), keyed by `name` so edits persist across runs. `schema` declares
   * the column names + types (number → numeric input; code → opens in the main
   * editor); a column tracks the schema exactly unless the table panel has
   * genuinely touched it, which claims it for the user. `seedRows` populate
   * the table the first time it's created.
   */
  editable(name: string, schema: Schema, seedRows?: Row[]): Table
  /**
   * The Expr helpers, grouped: expr.field/lit/idx build diffable expressions
   * over a row (chain .add/.mul/.gt/.cond/… and math like .sin()/.clamp());
   * expr.midi/slider/time are live per-frame sources — a field derived from
   * one follows the note, slider, or playback clock as the loop replays —
   * and expr.progress() reads the enclosing event's percent-done. e.g.
   * filter(expr.field("v").gt(3)), derive({ py: expr.slider("height") }).
   */
  expr: ExprNamespace
  /** The tap-beat table: one row per wall-time button press ({ beat, time }) — the source of truth for tempo. */
  taps(): Table
  /** Seconds per beat derived from the taps (average interval), or `fallback` (default 0.5s = 120 BPM) until two taps exist. The playhead already runs at this tempo; tempo() is for programs that want the number. */
  tempo(fallback?: number): number
  /**
   * A single-row timeline: one "retime" event in the timeline schema (see
   * schemas.timeline). The pass length is the GUI "beats" control, so `count`
   * is only the loop length you intend — set the control to match. Identity by
   * default (content plays once per loop); pass { fit } in source-beats to
   * stretch that much content across the loop — beats(16, { fit: 8 }) plays 8
   * beats of content at half speed over a 16-beat loop. Concat more event rows
   * onto it for loops, holds, and reverses.
   */
  beats(count: number, opts?: { fallback?: number; fit?: number }): Table
  /**
   * Canonical schemas for the tables the runtime knows by name — pass one to
   * editable() for the right columns, enum dropdowns, and code languages:
   * editable("hydra", schemas.hydra). Frozen; spread to extend:
   * editable("hydra", { ...schemas.hydra, extra: "string" }).
   */
  schemas: Schemas
}

export function createDSL(ctx: DSLContext | null): DSLSurface {
  const asTable = (x: Table | Row[] | null | undefined): Table =>
    x instanceof Table ? x : new Table(x ?? [], ctx)

  const three: ThreeNamespace = {
    box: (props: Row = {}) => sceneObject('box', props, ctx),
    sphere: (props: Row = {}) => sceneObject('sphere', props, ctx),
    cylinder: (props: Row = {}) => sceneObject('cylinder', props, ctx),
    cone: (props: Row = {}) => sceneObject('cone', props, ctx),
    torus: (props: Row = {}) => sceneObject('torus', props, ctx),
    text: (props: Row = {}) => sceneObject('text', props, ctx),
    // A light isn't a mesh, so it skips sceneObject's px/py/pz:0 defaults —
    // leaving position unset lets the renderer apply the kind's own default.
    light: (props: Row = {}) => new Table([{
      id: 'light', event: 'create', beat: 1, shape: 'light', kind: 'directional', ...props,
    }], ctx),
    object: (shape: string, props: Row = {}) => sceneObject(shape, props, ctx),
    points: (shape: string, props: Row = {}): Table => {
      const { segments, ...dims } = props
      const geo = primitiveGeometry(shape, dims, typeof segments === 'number' ? { segments } : {})
      const rows = pointsFromGeometry(geo)
      geo.dispose()
      return new Table(rows, ctx)
    },
    geometry: (points: Table | Row[]): BufferGeometry =>
      geometryFromPoints(rowsOf(points)),
    // The first keyframe seeds a full default pose so a partial first row is
    // still well-defined.
    camera: (keyframes: Row[] | null | undefined): Table => new Table(
      (keyframes ?? []).map((k, i) => {
        const beat = typeof k.beat === 'number' ? k.beat : 1
        return i === 0
          ? { px: 0, py: 0, pz: 5, tx: 0, ty: 0, tz: 0, ...k, id: 'camera', shape: 'camera', event: 'create', beat }
          : { ...k, id: 'camera', shape: 'camera', event: 'update', beat }
      }),
      ctx,
    ),
    translate: (table: Table | Row[], x = 0, y = 0, z = 0): Table =>
      asTable(table).map((r) => modRow(r, [
        ['px', 0, (v) => v + x], ['py', 0, (v) => v + y], ['pz', 0, (v) => v + z],
      ])),
    scale: (table: Table | Row[], x = 1, y?: number, z?: number): Table =>
      asTable(table).map((r) => modRow(r, [
        ['sx', 1, (v) => v * x], ['sy', 1, (v) => v * (y ?? x)], ['sz', 1, (v) => v * (z ?? x)],
      ])),
    rotate: (table: Table | Row[], x = 0, y = 0, z = 0): Table =>
      asTable(table).map((r) => modRow(r, [
        ['rx', 0, (v) => v + x], ['ry', 0, (v) => v + y], ['rz', 0, (v) => v + z],
      ])),
  }

  return {
    define: (name: string, group: string | ViewFn, fn?: ViewFn) =>
      fn === undefined
        ? ctx!.defineLazy(name, group as ViewFn)
        : ctx!.defineLazy(name, fn, group as string),
    table: ((name?: string | Row[], source?: ViewFn | Table | Row[]) => {
      if (typeof name !== 'string') return new Table((name ?? []).map((r) => ({ ...r })), ctx)
      if (source === undefined) return ctx!.resolve(name)
      if (typeof source === 'function') return void ctx!.defineLazy(name, source)
      return (source instanceof Table ? source : new Table((source ?? []).map((r) => ({ ...r })), ctx)).save(name)
    }) as DSLSurface['table'],
    math: (fn: (t: number) => number) => new MathBuilder(fn, ctx!),
    rows: (arr: Row[] | null | undefined) => new Table((arr ?? []).map((r) => ({ ...r })), ctx),
    rotate: (rows: Row[] | null | undefined, values: Row[] | null | undefined): Table => {
      const src = rows ?? []
      return new Table(
        (values ?? []).map((v, i) => (src.length ? { ...src[i % src.length], ...v } : { ...v })),
        ctx,
      )
    },
    csv: (text: string) => new Table(parseCSV(text), ctx),
    data: (url: string) => new Table(parseCSV(ctx?.getData?.(url) ?? ''), ctx),
    json: (data: Row[] | string | unknown) => new Table(
      (Array.isArray(data) ? data : typeof data === 'string' ? JSON.parse(data) as Row[] : []).map((r) => ({ ...r as Row })),
      ctx,
    ),
    grid: (cols: number, rowsN: number, { spacing = 0.7, y = 0 } = {}): Table => {
      const out: Row[] = []
      const total = Math.max(0, cols * rowsN)
      for (let i = 0; i < total; i++) {
        const c = i % cols
        const rr = Math.floor(i / cols)
        out.push({
          i, col: c, row: rr,
          px: (c - (cols - 1) / 2) * spacing, py: y, pz: (rr - (rowsN - 1) / 2) * spacing,
        })
      }
      return new Table(out, ctx)
    },
    physics: (source: Table | Row[]) => new PhysicsBuilder(source, ctx!),
    three,
    t: three,
    origami: makeOrigami(ctx),
    editable: (name: string, schema: Schema, seedRows?: Row[]): Table => {
      const rows = (ctx?.editableRows?.(name, schema, seedRows) ?? []).map((r) => ({ ...r }))
      return new Table(rows, ctx).save(name)
    },
    expr: makeExprNamespace(ctx),
    taps: () => new Table((ctx?.tapRows?.() ?? []).map((r) => ({ ...r })), ctx),
    tempo: (fallback = DEFAULT_BEAT_SECONDS): number => beatSecondsFromTaps(ctx?.tapRows?.()) ?? fallback,
    beats: (_count: number, { fit }: { fit?: number } = {}): Table => new Table([
      fit != null ? { event: 'retime', beat: 1, from: 1, to: fit + 1 } : { event: 'retime', beat: 1 },
    ], ctx),
    ...EASINGS,
    schemas: SCHEMAS,
  }
}
