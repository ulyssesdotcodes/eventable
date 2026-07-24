// eventable bauble — table-driven 3D SDF sketches (bauble.studio: Janet code
// compiled to a GLSL raymarcher). The "bauble" view mirrors the hydra table:
// events placed by a 1-indexed `beat` column, folded at a frame into a Janet
// script. setCode replaces the sketch; the meta events rewrite the accumulated
// code structurally — a bauble sketch is one s-expression to wrap or combine,
// not a chain to splice like hydra's: transform/duplicate/combine/replace edit
// it, slice/tile/radial are named wrappers for the classic SDF moves, and
// transition morphs from the program so far to the program at the next setCode
// ahead, on the t clock (byte-stable — no recompile mid-wipe).
// Unlike hydra's per-frame props, setVariable values BAKE into the compiled
// shader (changing one recompiles) — except the reserved camera-x/-y/-zoom
// trio, which the renderer consumes as plain uniforms. This module is pure;
// compiling and rendering live in bauble-scene.ts.

import { beatToFrame, beatsToFrames, FPS } from './constants.js'
import { contentSeqLen, transitionSpan, transitionAt, transitionWindowsIn, type TransitionWindow } from './hydra.js'
import type { Row } from './lineage.js'

export interface BaubleFrame {
  code: string
  vars: Record<string, unknown>
}

// The two data events plus the meta-programming transforms that rewrite the
// accumulated code (each a no-op until a setCode establishes some).
const BAUBLE_EVENTS = new Set([
  'setCode', 'setVariable',
  'transform', 'duplicate', 'combine', 'replace',
  'transition', 'slice', 'tile', 'radial',
])

export function isBaubleRow(row: Row | null | undefined): boolean {
  return row != null && typeof row.event === 'string' && BAUBLE_EVENTS.has(row.event)
}

export function baubleRows(rows: Row[] | null | undefined): Row[] {
  return (rows ?? []).filter(isBaubleRow)
}

// Place each row on the frame grid from its 1-indexed `beat` (frame stored on
// `index`, the field baubleFrameAt samples against) and sort by frame. The beat
// axis is absolute: a beat past the loop's end lands the row in a later pass
// (the visualizer wraps the playhead into this grid — see visualizer.ts).
export function buildBaubleIndex(rows: Row[] | null | undefined): Row[] {
  return baubleRows(rows)
    .map((row) => ({
      ...row,
      index: beatToFrame((row.beat as number | undefined) ?? 1),
    }))
    .sort((a, b) => (a.index as number) - (b.index as number))
}

// The bauble table's transition strip-spans — until-next windows over the
// whole table (one folded program, no per-output routing).
export function baubleTransitionWindows(rows: Row[] | null | undefined, loopBeats = 0): TransitionWindow[] {
  const index = buildBaubleIndex((rows ?? []).map((row, i) => ({ ...row, __row: i })))
  const loopFrames = beatsToFrames(loopBeats)
  return transitionWindowsIn([index], contentSeqLen(index, loopFrames), loopFrames)
}

// Apply a transform form to a subject shape expression. A standalone `_`
// (delimited by whitespace/brackets/string bounds — never part of a longer
// symbol) is the hole: every occurrence becomes the subject, so a form can use
// the shape twice ("(union _ (mirror _ :x))"). With no hole the subject is
// inserted as the form's first argument — bauble's own "shape first"
// convention — and a bare symbol becomes a call: "symmetry" → "(symmetry S)".
const HOLE = /(^|[\s()[\]{}])_(?=[\s()[\]{}]|$)/g
export function applyForm(form: string, subject: string): string {
  const f = form.trim()
  HOLE.lastIndex = 0
  if (HOLE.test(f)) return f.replace(HOLE, (_, pre: string) => `${pre}${subject}`)
  const head = f.match(/^\(\s*[^\s()[\]{}]+/)
  if (head) return `${f.slice(0, head[0].length)} ${subject}${f.slice(head[0].length)}`
  return `(${f} ${subject})`
}

// The combiners a duplicate/combine event picks via `mode`, mapped to how each
// spends the `value` cell: the `:r` smooth-blend radius, or morph's trailing
// blend amount. The keys double as the enum options in the table.
const COMBINE_OPS: Record<string, 'radius' | 'amount'> = {
  union: 'radius', intersect: 'radius', subtract: 'radius', morph: 'amount',
}
export const BAUBLE_COMBINE_MODES: string[] = Object.keys(COMBINE_OPS)

// A `value` cell as a combiner argument — strings verbatim, so the radius or
// amount can be any Janet expression. Null omits it (bauble's own default
// applies: a hard union, morph's 0.5).
function combineValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return null
}

function combineShapes(mode: string, a: string, b: string, value: unknown): string {
  const v = combineValue(value)
  if (COMBINE_OPS[mode] === 'amount') return v != null ? `(${mode} ${a} ${b} ${v})` : `(${mode} ${a} ${b})`
  return v != null ? `(${mode} :r ${v} ${a} ${b})` : `(${mode} ${a} ${b})`
}

// The axis a slice/radial row works about — the `axis` cell when it names one,
// y otherwise (a blank or malformed cell behaves like the default).
function axisOf(row: Row): string {
  const a = typeof row.axis === 'string' ? row.axis.trim() : ''
  return a === 'x' || a === 'y' || a === 'z' ? a : 'y'
}

// Apply one code-shape event — everything that rewrites the accumulated Janet
// program. setVariable/transition leave it unchanged (handled separately).
function applyBaubleShape(code: string | null, row: Row): string | null {
  switch (row.event) {
    case 'setCode':
      return typeof row.code === 'string' ? row.code : code
    case 'transform':
      if (code != null && typeof row.code === 'string' && row.code.trim() !== '') return applyForm(row.code, code)
      return code
    case 'duplicate':
      // Combine the shape with a copy of itself run through `code` (blank = a
      // verbatim copy).
      if (code != null) {
        const mode = typeof row.mode === 'string' && row.mode in COMBINE_OPS ? row.mode : 'union'
        const copyForm = typeof row.code === 'string' ? row.code.trim() : ''
        const copy = copyForm === '' ? code : applyForm(copyForm, code)
        return combineShapes(mode, code, copy, row.value)
      }
      return code
    case 'combine':
      // Composite another whole shape onto the current one.
      if (code != null && typeof row.code === 'string' && row.code.trim() !== '') {
        const mode = typeof row.mode === 'string' && row.mode in COMBINE_OPS ? row.mode : 'union'
        return combineShapes(mode, code, row.code.trim(), row.value)
      }
      return code
    case 'replace':
      // Literal substring swap over the whole current sketch (no regex).
      if (code != null && typeof row.find === 'string' && row.find !== '')
        return code.split(row.find).join(row.value == null ? '' : String(row.value))
      return code
    case 'slice':
      // Cut the shape open as a shell: onion at `value` thickness (3 when
      // unset), the cutter subtracted being `code` (any shape) or a half-space
      // about the `axis` cell.
      if (code != null) {
        const thickness = combineValue(row.value) ?? '3'
        const cutter = typeof row.code === 'string' && row.code.trim() !== ''
          ? row.code.trim()
          : `(half-space :${axisOf(row)})`
        return `(subtract (onion ${code} ${thickness}) ${cutter})`
      }
      return code
    case 'tile':
      // Repeat the shape on an infinite lattice: a number `value` spaces all
      // three axes evenly, a string is a vec3 (or any Janet expression)
      // verbatim. No spacing → no-op (a zero-spaced lattice is degenerate).
      if (code != null) {
        const v = row.value
        const spacing = typeof v === 'number' && Number.isFinite(v) && v > 0
          ? `[${v} ${v} ${v}]`
          : typeof v === 'string' && v.trim() !== '' ? v.trim() : null
        if (spacing != null) return `(tile ${code} ${spacing})`
      }
      return code
    case 'radial':
      // Repeat the shape in a circular array of `value` copies (6 when unset)
      // about the `axis` cell.
      if (code != null) {
        const count = typeof row.value === 'number' && Number.isFinite(row.value) && row.value >= 1
          ? Math.floor(row.value)
          : 6
        return `(radial ${code} :${axisOf(row)} ${count})`
      }
      return code
    default:
      return code
  }
}

// The active sketch at (absolute) frame `f`: every event at/before it folds
// in — setCode replaces the code, the meta events evolve it, setVariable folds
// into the latest value per name. A transition morphs from the program at its
// beat to the program at the next setCode ahead (its window end), revealing
// that destination mid-wipe via look-ahead: code-shape events fold up to the
// furthest active window end, on the (ss t start end) playback clock. Returns
// null until a setCode is reached — playback then leaves the bauble layer blank.
export function baubleFrameAt(index: Row[], f: number, loopFrames = 0): BaubleFrame | null {
  const frame = Math.floor(f)
  if (frame < 0) return null
  const seqLen = contentSeqLen(index, loopFrames)
  const vars: Record<string, unknown> = {}
  for (const row of index) {
    if ((row.index as number) > frame) break
    if (row.event === 'setVariable' && typeof row.name === 'string') vars[row.name] = row.value
  }
  const active: { before: string; start: number; len: number; end: number }[] = []
  let running: string | null = null
  let codeAtF: string | null = null
  for (let p = 0; p < index.length; p++) {
    const row = index[p]
    if (row.event === 'transition') {
      if (running != null) {
        const span = transitionSpan(index, p, seqLen, loopFrames)
        if (span != null && transitionAt(frame, row.index as number, span.len, seqLen) != null) {
          active.push({ before: running, start: row.index as number, len: span.len, end: span.end })
        }
      }
    } else if (row.event !== 'setVariable') {
      running = applyBaubleShape(running, row)
    }
    if ((row.index as number) <= frame) codeAtF = running
  }
  const horizon = active.length ? Math.max(...active.map((a) => a.end)) : frame
  let after: string | null = null
  for (const row of index) {
    if ((row.index as number) > horizon) break
    if (row.event !== 'transition' && row.event !== 'setVariable') after = applyBaubleShape(after, row)
  }
  let code = after ?? codeAtF
  if (code == null) return null

  // Apply the wipes from the innermost (latest) out: the final program is the
  // last transition's "after", and each earlier transition morphs its own
  // frozen "before" toward the wipe that follows it — nested transitions
  // compose in beat order, the earliest wrapping all the later ones. (ss t
  // start end) ramps 0 → 1 across the window on the playback clock.
  for (let i = active.length - 1; i >= 0; i--) {
    const tr = active[i]
    code = `(morph ${tr.before} ${code} (ss t ${tr.start / FPS} ${(tr.start + tr.len) / FPS}))`
  }
  return { code, vars }
}

// Reserved names the renderer consumes directly as camera uniforms — never
// compiled into the Janet script, so driving them per frame never recompiles.
// camera-x/-y orbit in turns; camera-zoom scales distance (1 = default framing).
export const BAUBLE_CAMERA_VARS = ['camera-x', 'camera-y', 'camera-zoom'] as const

export function isBaubleCameraVar(name: string): boolean {
  return (BAUBLE_CAMERA_VARS as readonly string[]).includes(name)
}

// Render one variable value as a Janet expression; strings insert verbatim so
// a value can be any Janet expression. Null means skip the variable rather
// than compile a broken (def …).
function janetValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return null
}

// The complete Janet script for a sampled frame: one (def name value) per
// variable (camera vars excluded — the renderer owns those), then the code.
// Its string identity is bauble-scene.ts's recompile gate.
export function baubleScript(frame: BaubleFrame): string {
  const defs: string[] = []
  for (const [name, value] of Object.entries(frame.vars)) {
    if (isBaubleCameraVar(name)) continue
    const v = janetValue(value)
    if (v != null) defs.push(`(def ${name} ${v})`)
  }
  return defs.length ? `${defs.join('\n')}\n${frame.code}` : frame.code
}

// The compiled script shown for one table row: the full fold sampled at that
// row's own frame — exactly what the runtime shows there (a transition row's
// popover morphs toward the next setCode via look-ahead; the destination
// setCode row, a window end, shows the plain after program). Mirrors
// hydraCodeUpToRow. loopFrames defaults to unwrapped when the panel has none.
export function baubleCodeUpToRow(rows: Row[] | null | undefined, rowIndex: number, loopFrames = 0): string | null {
  const all = rows ?? []
  if (!isBaubleRow(all[rowIndex])) return null
  const index = buildBaubleIndex(all.map((row, i) => ({ ...row, __row: i })))
  const pos = index.findIndex((r) => (r as { __row?: number }).__row === rowIndex)
  if (pos < 0) return null
  const frame = baubleFrameAt(index, index[pos].index as number, loopFrames)
  return frame ? baubleScript(frame) : null
}
