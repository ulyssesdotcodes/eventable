// eventable MIDI — an append-only event log folded into a streaming table.
// Like sliders, the log rides the shared editable-table store, so recorded
// MIDI syncs over multiplayer and persists in the session. Events are stamped
// with the playhead's content/source position (a 1-indexed beat, not wall
// time), which is what makes a recorded sweep's speed track the timeline
// mapping, plus the loop iteration it was recorded in.

import { beatToFrame } from './constants.js'
import type { StampedEvent } from './event-log.js'
import type { Row } from './lineage.js'
import type { EvalCtx } from './dsl.js'

const SEMITONES: Record<string, number> = {
  c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11,
}
const SHARP_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']

// "c4" / "C#4" / "db3" → MIDI note number (C4 = 60), or null if unparseable.
export function noteToNumber(name: string): number | null {
  const m = /^([a-g])([#b]?)(-?\d+)$/i.exec(String(name).trim())
  if (!m) return null
  const base = SEMITONES[m[1].toLowerCase()]
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0
  const octave = parseInt(m[3], 10)
  return (octave + 1) * 12 + base + accidental
}

// MIDI note number → canonical lower-case note name (sharps), e.g. 60 → "c4".
export function numberToNote(n: number): string {
  const name = SHARP_NAMES[((n % 12) + 12) % 12]
  const octave = Math.floor(n / 12) - 1
  return `${name}${octave}`
}

// ── Decoding raw MIDI bytes ──────────────────────────────────────────────────

export interface DecodedMidi {
  note: string
  noteNum: number
  channel: number // 1-based (1–16)
  value: number   // normalized 0–1 (velocity, or CC value)
}

// Decode a raw [status, data1, data2] message into a normalized event, or null
// for messages we don't track. Note-on with velocity 0 is treated as note-off.
export function decodeMidi(data: ArrayLike<number>): DecodedMidi | null {
  const status = data[0] ?? 0
  const type = status & 0xf0
  const channel = (status & 0x0f) + 1
  const d1 = data[1] ?? 0
  const d2 = data[2] ?? 0
  if (type === 0x90) return { note: numberToNote(d1), noteNum: d1, channel, value: d2 / 127 }
  if (type === 0x80) return { note: numberToNote(d1), noteNum: d1, channel, value: 0 }
  if (type === 0xb0) return { note: `cc${d1}`, noteNum: d1, channel, value: d2 / 127 }
  return null
}

// A decoded event + the source position (a 1-indexed beat) it landed at → a row.
export function midiRow(d: DecodedMidi, beat: number): Row {
  return { type: 'midi', note: d.note, noteNum: d.noteNum, channel: d.channel, value: d.value, beat }
}

// ── Indexing + sampling ──────────────────────────────────────────────────────

interface MidiSample {
  frame: number
  channel: number
  value: number
}

export type MidiIndex = Map<string, MidiSample[]>

// Group rows by note name, sorted ascending by frame (event beats
// pre-converted), for fast "most recent at-or-before" lookups.
export function buildMidiIndex(rows: Row[] | null | undefined): MidiIndex {
  const map: MidiIndex = new Map()
  for (const r of rows ?? []) {
    const note = String(r.note ?? '').toLowerCase()
    if (!note) continue
    if (!map.has(note)) map.set(note, [])
    map.get(note)!.push({
      frame: beatToFrame((r.beat as number | undefined) ?? 1),
      channel: (r.channel as number | undefined) ?? 0,
      value: (r.value as number | undefined) ?? 0,
    })
  }
  for (const list of map.values()) list.sort((a, b) => a.frame - b.frame)
  return map
}

// The active value of a note at `frame`: the most recent event at-or-before it,
// restricted to `channel` when one is given (null = any channel). 0 if none yet.
export function sampleMidiAt(index: MidiIndex, note: string, channel: number | null, frame: number): number {
  const list = index.get(note.toLowerCase())
  if (!list) return 0
  let value = 0
  for (const s of list) {
    if (s.frame > frame) break
    if (channel == null || s.channel === channel) value = s.value
  }
  return value
}

// ── The fold: event log → current table ─────────────────────────────────────
// Per note: only the events from the most recent loop it was recorded in — a
// new take replaces the old, untouched notes carry forward — deduped to one
// row per (channel, frame) so a burst at one source frame collapses to the
// last value. Pure; the log is never rewritten.
export function currentMidiRows(events: StampedEvent[]): Row[] {
  const perNote = new Map<string, { loop: number; byKey: Map<string, Row> }>()
  for (const e of events) {
    if (e.kind === 'clear') { perNote.clear(); continue }
    if (e.kind !== 'midi') continue
    const note = e.note as string
    const loop = (e.loop as number | undefined) ?? 0
    let entry = perNote.get(note)
    if (!entry || loop > entry.loop) {
      entry = { loop, byKey: new Map() }
      perNote.set(note, entry)
    } else if (loop < entry.loop) {
      continue // stale (shouldn't happen with a monotonic loop counter)
    }
    const frame = beatToFrame((e.beat as number | undefined) ?? 1)
    entry.byKey.set(`${e.channel as number}:${frame}`, {
      type: 'midi', note, noteNum: e.noteNum, channel: e.channel,
      value: e.value, beat: e.beat, loop,
    })
  }
  const out: Row[] = []
  for (const entry of perNote.values()) out.push(...entry.byKey.values())
  out.sort((a, b) => ((a.beat as number) - (b.beat as number)) || ((a.channel as number) - (b.channel as number)))
  return out
}

// ── Live input ───────────────────────────────────────────────────────────────

// The midi log, abstracted to just what the input needs — the exact twin of
// sliders' SliderStore. main.ts backs this with the editable-table store —
// riding the store is what makes recorded MIDI sync over multiplayer and
// persist in the session.
export interface MidiStore {
  record(kind: string, payload?: Record<string, unknown>): void
  events(): StampedEvent[]
  onChange(cb: () => void): void
}

export interface MidiInputOptions {
  store: MidiStore
  // Where new events get stamped: the playhead's content/source position (a
  // 1-indexed beat, Playback.currentSourceBeats) — the coordinate the baked
  // scene is keyed to, so a recorded sweep tracks the timeline mapping.
  getIndex: () => number
  // Current loop iteration, folded into each event so the fold can keep each
  // note's most recent take.
  getLoop?: () => number
}

export interface MidiInput {
  // The folded current table (the "midi" view).
  rows(): Row[]
  // The raw append-only log (the "midi·events" view).
  eventRows(): Row[]
  clear(): void
  // Per-frame evaluation context for resolveBindings: midi(note) samples the
  // folded table at `srcFrame`.
  ctxAt(srcFrame: number): EvalCtx
  // Feed a raw message (exposed for the browser listener and for tests).
  feed(data: ArrayLike<number>): void
}

export function createMidiInput({ store, getIndex, getLoop }: MidiInputOptions): MidiInput {
  // Fold caches, invalidated on any store change (local, peer merge, or
  // session load).
  let current: Row[] | null = null
  let index: MidiIndex | null = null

  store.onChange(() => { current = null; index = null })

  const rows = (): Row[] => (current ??= currentMidiRows(store.events()))
  const idx = (): MidiIndex => (index ??= buildMidiIndex(rows()))

  function feed(data: ArrayLike<number>): void {
    const decoded = decodeMidi(data)
    if (!decoded) return
    store.record('midi', {
      note: decoded.note, noteNum: decoded.noteNum, channel: decoded.channel, value: decoded.value,
      beat: getIndex(),
      loop: getLoop?.() ?? 0,
    })
  }

  return {
    rows: () => rows().map((r) => ({ ...r })),
    eventRows: () => store.events()
      .filter((e) => e.kind === 'midi' || e.kind === 'clear')
      .map(({ kind, seq, t, loop, beat, note, channel, value }) => ({ seq, t, kind, loop, beat, note, channel, value })),
    clear: () => store.record('clear'),
    ctxAt: (srcFrame: number): EvalCtx => ({
      midi: (note, channel) => sampleMidiAt(idx(), note, channel, srcFrame),
    }),
    feed,
  }
}

// Best-effort Web MIDI subscription, separate from the input itself so synced
// or session-loaded MIDI plays back with no hardware. Requesting device access
// pops a browser permission prompt, so main.ts calls this only once the user
// enables the MIDI toggle. No-ops where unavailable.
export function subscribeWebMidi(input: Pick<MidiInput, 'feed'>): void {
  const access = (navigator as Navigator & {
    requestMIDIAccess?: () => Promise<{ inputs: Map<unknown, { onmidimessage: ((e: { data: Uint8Array }) => void) | null }> }>
  }).requestMIDIAccess
  if (typeof access !== 'function') {
    console.warn('[midi] Web MIDI API not available in this browser')
    return
  }
  access.call(navigator).then((midi) => {
    const inputs = [...midi.inputs.values()]
    console.log('[midi] access granted, inputs:', inputs.length)
    for (const device of inputs) {
      console.log('[midi] subscribing to input:', (device as unknown as { name?: string }).name ?? device)
      device.onmidimessage = (e) => input.feed(e.data)
    }
  }).catch((err) => { console.warn('[midi] access denied:', err) })
}
