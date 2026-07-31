// eventable sliders — on-screen controls, event-logged like MIDI. What is
// stored is the append-only log of value changes, each stamped with the
// playhead's content/source position (a 1-indexed beat), so a recorded move
// replays every loop and tracks the timeline mapping. Like MIDI, the log rides
// the shared editable-table store, which buys multiplayer sync and session
// persistence for free. Slider definitions come from the program (a view named
// "sliders" with { name, min, max, default? } rows).

import { beatToFrame } from './constants.js'
import type { LogStore, StampedEvent } from './event-log.js'
import type { Row } from './lineage.js'
import type { EvalCtx } from './dsl.js'

// ── Definitions ──────────────────────────────────────────────────────────────

export interface SliderDef {
  id: string
  min: number
  max: number
  // What the control and slider(id) read before any recording.
  default: number
  // Defaults to ~1/1000 of the range; pass `step: 1` for an integer slider.
  step: number
}

const clamp = (v: number, lo: number, hi: number): number =>
  hi < lo ? v : Math.min(hi, Math.max(lo, v))

// Structural equality for a def — the store's onChange carries no delta, so
// this is what lets the overlay reuse its existing def objects.
export function sameSliderDef(a: SliderDef, b: SliderDef): boolean {
  return a.id === b.id && a.min === b.min && a.max === b.max &&
    a.default === b.default && a.step === b.step
}

// Parse one definition row into a normalized def, or null if it has no name.
export function sliderDef(row: Row): SliderDef | null {
  const id = row.name != null ? String(row.name) : ''
  if (!id) return null
  const min = Number(row.min ?? 0)
  const max = Number(row.max ?? 1)
  const raw = row.default != null ? Number(row.default) : min
  const def = Number.isFinite(raw) ? raw : min
  const span = max - min
  const rawStep = row.step != null ? Number(row.step) : NaN
  const step = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : (span > 0 ? span / 1000 : 1)
  return { id, min, max, default: clamp(def, min, max), step }
}

// One def per id — a later row with the same id replaces an earlier one.
export function sliderDefs(rows: Row[] | null | undefined): SliderDef[] {
  const byId = new Map<string, SliderDef>()
  for (const r of rows ?? []) {
    const d = sliderDef(r)
    if (d) byId.set(d.id, d)
  }
  return [...byId.values()]
}

// ── Indexing + sampling ──────────────────────────────────────────────────────

interface SliderSample {
  frame: number
  value: number
}

export type SliderIndex = Map<string, SliderSample[]>

// Group rows by slider id, sorted ascending by frame (event beats
// pre-converted), for fast "most recent at-or-before" lookups.
export function buildSliderIndex(rows: Row[] | null | undefined): SliderIndex {
  const map: SliderIndex = new Map()
  for (const r of rows ?? []) {
    const id = r.id != null ? String(r.id) : ''
    if (!id) continue
    if (!map.has(id)) map.set(id, [])
    map.get(id)!.push({
      frame: beatToFrame((r.beat as number | undefined) ?? 1),
      value: (r.value as number | undefined) ?? 0,
    })
  }
  for (const list of map.values()) list.sort((a, b) => a.frame - b.frame)
  return map
}

// The most recent move at-or-before `frame`. Before the loop's first recorded
// move, that first value (so each loop starts where the automation begins,
// not at the loop-end value); with no recording at all, `fallback`.
export function sampleSliderAt(index: SliderIndex, id: string, frame: number, fallback: number): number {
  const list = index.get(id)
  if (!list || !list.length) return fallback
  let value: number | null = null
  for (const s of list) {
    if (s.frame > frame) break
    value = s.value
  }
  return value ?? list[0].value
}

// ── The fold: event log → current table ─────────────────────────────────────
// Per id: moves since the last `clear` for it, deduped to one row per frame
// (a drag burst at one source frame collapses to the last value). A `clear`
// with an `id` — fired when the user grabs the slider — is the take boundary:
// loop counters aren't comparable across peers, an explicit shared clear is.
// Pure; the log is never rewritten.
export function currentSliderRows(events: StampedEvent[]): Row[] {
  const perId = new Map<string, Map<number, Row>>()
  for (const e of events) {
    if (e.kind === 'clear') {
      if (e.id != null) perId.delete(String(e.id))
      else perId.clear()
      continue
    }
    if (e.kind !== 'slider') continue
    const id = String(e.id)
    let byFrame = perId.get(id)
    if (!byFrame) { byFrame = new Map(); perId.set(id, byFrame) }
    const frame = beatToFrame((e.beat as number | undefined) ?? 1)
    byFrame.set(frame, { type: 'slider', id, value: e.value, beat: e.beat })
  }
  const out: Row[] = []
  for (const byFrame of perId.values()) out.push(...byFrame.values())
  out.sort((a, b) => ((a.beat as number) - (b.beat as number)) ||
    String(a.id).localeCompare(String(b.id)))
  return out
}

// ── Live input ───────────────────────────────────────────────────────────────

export interface SliderInputOptions {
  store: LogStore
  // Where new moves get stamped: the playhead's content/source position (a
  // 1-indexed beat, Playback.currentSourceBeats) — comparable across peers,
  // unlike wall time.
  getIndex: () => number
}

export interface SliderInput {
  // The folded current table (the "slider" view).
  rows(): Row[]
  // The raw log (the "slider·events" view).
  eventRows(): Row[]
  // Replace the active slider definitions (from the program's "sliders" view).
  setDefs(defs: SliderDef[]): void
  defs(): SliderDef[]
  // Record a value for `id` at the current source position.
  set(id: string, value: number): void
  // Open a recording window: drop the old take and start recording anew,
  // anchored at the current source position (the grab beat). Fired when the
  // user grabs the slider.
  beginRecord(id: string): void
  // Stream a live value into the open window at the current source position.
  // Fired on every pointer move while grabbed.
  setLive(id: string, value: number): void
  // Advance every open window by the playhead. Once a window has swept one full
  // cycle back to its grab beat, it closes and the fresh take starts replaying.
  recordTick(srcBeat: number): void
  // Whether `id` has an open recording window (its value follows the live hand,
  // not the recorded take).
  recording(id: string): boolean
  // Drop one slider's recorded take. beginRecord does this at grab; kept as a
  // standalone primitive.
  clearId(id: string): void
  clear(): void
  // Per-frame evaluation context for resolveBindings: slider(id) samples the
  // folded table at `srcFrame`; sliders() returns every defined id's value.
  ctxAt(srcFrame: number): EvalCtx
  // Every defined slider's value at `srcFrame` — what the UI thumbs follow.
  valuesAt(srcFrame: number): Record<string, number>
}

// One slider's open recording window. `grabBeat` anchors the window; it closes
// after the playhead sweeps a full cycle back to it (`wrapped` guards against
// closing on the first tick, before the position has climbed past the grab).
// `value` is the live hand — what the slider reads while recording, since the
// fresh take isn't a full cycle yet.
interface Recording {
  grabBeat: number
  value: number
  lastBeat: number
  wrapped: boolean
}

export function createSliderInput({ store, getIndex }: SliderInputOptions): SliderInput {
  let defList: SliderDef[] = []
  let defById = new Map<string, SliderDef>()
  // Fold caches, invalidated on any store change (local, peer merge, or
  // session load).
  let current: Row[] | null = null
  let index: SliderIndex | null = null
  // Ids with an open recording window: their value follows the live hand, not
  // the recorded take, until the window closes one cycle after the grab.
  const rec = new Map<string, Recording>()

  store.onChange(() => { current = null; index = null })

  const rows = (): Row[] => (current ??= currentSliderRows(store.events()))
  const idx = (): SliderIndex => (index ??= buildSliderIndex(rows()))
  const fallbackFor = (id: string): number => defById.get(id)?.default ?? 0
  // Record without playback: while a window is open the slider holds the live
  // hand; only once it closes does the recorded take drive the value again.
  const sampleId = (id: string, srcFrame: number, fallback: number): number => {
    const r = rec.get(id)
    return r ? r.value : sampleSliderAt(idx(), id, srcFrame, fallback)
  }
  const readAll = (srcFrame: number): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const d of defList) out[d.id] = sampleId(d.id, srcFrame, d.default)
    return out
  }

  return {
    rows: () => rows().map((r) => ({ ...r })),
    eventRows: () => store.events()
      .filter((e) => e.kind === 'slider' || e.kind === 'clear')
      .map(({ kind, seq, t, beat, id, value }) => ({ seq, t, kind, beat, id, value })),
    setDefs(defs: SliderDef[]): void {
      defList = defs
      defById = new Map(defs.map((d) => [d.id, d]))
    },
    defs: () => defList,
    set(id: string, value: number): void {
      store.record('slider', { id, value, beat: getIndex() })
    },
    beginRecord(id: string): void {
      const grabBeat = getIndex()
      rec.set(id, { grabBeat, value: sampleSliderAt(idx(), id, beatToFrame(grabBeat), fallbackFor(id)), lastBeat: grabBeat, wrapped: false })
      store.record('clear', { id })
    },
    setLive(id: string, value: number): void {
      const r = rec.get(id)
      if (r) r.value = value
      store.record('slider', { id, value, beat: getIndex() })
    },
    recordTick(srcBeat: number): void {
      for (const [id, r] of rec) {
        if (srcBeat < r.lastBeat) r.wrapped = true
        r.lastBeat = srcBeat
        if (r.wrapped && srcBeat >= r.grabBeat) rec.delete(id)
      }
    },
    recording: (id: string) => rec.has(id),
    clearId(id: string): void {
      store.record('clear', { id })
    },
    clear(): void {
      store.record('clear')
    },
    ctxAt(srcFrame: number): EvalCtx {
      return {
        slider: (id) => sampleId(id, srcFrame, fallbackFor(id)),
        sliders: () => readAll(srcFrame),
      }
    },
    valuesAt: (srcFrame: number) => readAll(srcFrame),
  }
}
