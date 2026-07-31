// livecodata timeline — an OPTIONAL remap on top of the beat-grid playhead,
// defined as a table of EVENTS (see schemas.timeline). Rows are ordered by
// (loop, beat) and each covers an UNTIL-NEXT window: from its own `beat`
// (1-indexed) to the next row's, the last row running to the end of its pass.
// The pass length is the GUI loop-beats value the engine supplies, NOT the
// timeline's own extent — so buildTimeline/timelineSegments/windowsFor all
// take it as an argument (defaulting to DEFAULT_LOOP_BEATS for cook-time
// .retime, which has no playback loop to read).
//
// Each event warps its window onto source beats of the baked content —
// "retime" stretches input `from`..`to` into the output block
// `outFrom`..`outTo` (default the window; from > to runs backwards) and
// repeats the block across the window, "pingpong" is a retime whose block
// plays `from`..`to` there and back, "loop" cycles `from`..`to` at natural
// speed, "hold" freezes at `from`, "speed" runs from `from` at `rate`.
// Playback beats BEFORE the first row play unmapped (identity) — the timeline
// stays optional and partial-from-the-front; no timeline means identity
// everywhere. An optional 0-indexed `loop` column places a row in a later pass.
//
// Legacy sparse keyframe rows { beat, source } (no `event` column) are still
// accepted: consecutive keyframes become linear segments, exactly the old
// straight-map behavior.

import type { Row } from './lineage.js'
import { DEFAULT_LOOP_BEATS } from './constants.js'

export interface Timeline {
  // Is a real (non-identity) timeline defined?
  active: boolean
  // ONE pass's length in playback beats — the GUI loop-beats value; the
  // playhead wraps per pass, whatever `loops` is.
  beats: number
  // How many passes of the loop the rows span (1 = single-loop).
  loops: number
  // Map a 1-indexed playback beat (within pass `loop`, wrapped modulo `loops`)
  // to the 1-indexed source beat it shows.
  sourceBeatAt(playbackBeat: number, loop?: number): number
}

// One linear piece of the playback→source map: playback [p0, p1] plays source
// [s0, s1] (s0 > s1 runs backwards, s0 === s1 holds a frame).
export interface TimelineSegment {
  p0: number
  p1: number
  s0: number
  s1: number
  // The event row that produced this segment — undefined for the legacy
  // sparse-keyframe segments, which have no event kind of their own. Purely
  // descriptive (coverage-shading tint); playback never reads it.
  kind?: 'retime' | 'pingpong' | 'loop' | 'hold' | 'speed'
}

// One row's until-next window, local to its own pass (`lane`): the row covers
// playback beats [beat, end) of that pass. Shared by the playback compile and
// the timeline strip so the two can never disagree on where a window sits.
export interface RowWindow {
  // Storage index into the input rows array.
  row: number
  beat: number
  end: number
  lane: number
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

// Blank cells in an editable table conform to 0 (see conformRow), and beats
// are 1-indexed, so 0 in any optional column reads as "unset".
const opt = (v: unknown): number | undefined => (typeof v === 'number' && v !== 0 ? v : undefined)

// Order the enabled, beat-bearing rows by (loop, beat) and give each an
// until-next window: it runs to the next row's position, the last row to the
// end of the last pass any row touches (pass length = loopBeats). A row past
// one pass length via its beat, or placed by the `loop` column, extends the
// sequence to that many passes.
export function windowsFor(timelineRows: Row[], loopBeats: number = DEFAULT_LOOP_BEATS): RowWindow[] {
  const lb = loopBeats > 0 ? loopBeats : DEFAULT_LOOP_BEATS
  const rows = (timelineRows ?? [])
    .map((r, row) => ({ row, beat: num(r.beat), lane: Math.max(0, Math.floor(num(r.loop) ?? 0)) }))
    .filter((x): x is { row: number; beat: number; lane: number } =>
      typeof x.beat === 'number' && timelineRows[x.row].disabled !== true)
  if (!rows.length) return []
  // Extended playback axis: pass L's rows sit L pass-lengths after pass 0.
  const ext = (x: { beat: number; lane: number }): number => x.beat + x.lane * lb
  rows.sort((a, b) => a.lane - b.lane || a.beat - b.beat)
  const lastPass = rows.reduce((m, x) => Math.max(m, Math.floor((ext(x) - 1) / lb)), 0)
  const seqEnd = (lastPass + 1) * lb + 1
  return rows.map((x, i) => {
    const next = i + 1 < rows.length ? ext(rows[i + 1]) : seqEnd
    return { row: x.row, beat: x.beat, end: x.beat + Math.max(0, next - ext(x)), lane: x.lane }
  })
}

// Compile timeline rows into sorted segments on the extended playback axis
// (pass L's windows sit L * loopBeats beats after pass 0).
function compile(timelineRows: Row[], loopBeats: number = DEFAULT_LOOP_BEATS): { segments: TimelineSegment[]; span: number; loops: number } {
  const lb = loopBeats > 0 ? loopBeats : DEFAULT_LOOP_BEATS
  const windows = windowsFor(timelineRows, lb)
  if (!windows.length) return { segments: [], span: 0, loops: 1 }
  const rows = timelineRows ?? []
  const loops = windows.reduce((m, w) => Math.max(m, w.lane), 0) + 1

  const segments: TimelineSegment[] = []
  const keyframes = windows
    .filter((w) => typeof rows[w.row].event !== 'string')
    .map((w) => ({ beat: w.beat + w.lane * lb, src: opt(rows[w.row].source) ?? w.beat }))
    .sort((a, b) => a.beat - b.beat)
  for (let i = 1; i < keyframes.length; i++) {
    segments.push({ p0: keyframes[i - 1].beat, p1: keyframes[i].beat, s0: keyframes[i - 1].src, s1: keyframes[i].src })
  }

  for (const w of windows) {
    const r = rows[w.row]
    if (typeof r.event !== 'string') continue
    const off = w.lane * lb
    const p0 = w.beat + off
    const p1 = w.end + off
    if (!(p1 > p0)) continue
    const from = opt(r.from) ?? w.beat
    const to = opt(r.to) ?? w.end
    const kind = r.event as TimelineSegment['kind']
    // Tile a block across the window [p0, p1], clipping partial blocks at
    // both edges; o0 anchors the cycle phase, so a window starting mid-block
    // starts mid-source. `legs` splits the block into linear pieces as
    // fractions of the cycle — one 0..1 leg for retime/loop, a there-and-back
    // pair for pingpong.
    const tile = (o0: number, o1: number, legs: [number, number, number, number][]): void => {
      const cycle = o1 - o0
      if (!(cycle > 0)) {
        segments.push({ p0, p1, s0: from, s1: from, kind })
        return
      }
      for (let k = Math.floor((p0 - o0) / cycle); o0 + k * cycle < p1; k++) {
        const b0 = o0 + k * cycle
        for (const [f0, f1, sA, sB] of legs) {
          const h0 = b0 + f0 * cycle, h1 = b0 + f1 * cycle
          const q0 = Math.max(h0, p0), q1 = Math.min(h1, p1)
          if (!(q1 > q0)) continue
          segments.push({
            p0: q0, p1: q1,
            s0: sA + ((q0 - h0) / (h1 - h0)) * (sB - sA),
            s1: sA + ((q1 - h0) / (h1 - h0)) * (sB - sA),
            kind,
          })
        }
      }
    }
    const outBlock = (): [number, number] =>
      [(opt(r.outFrom) ?? w.beat) + off, (opt(r.outTo) ?? w.end) + off]
    switch (r.event) {
      case 'retime':
        tile(...outBlock(), [[0, 1, from, to]])
        break
      case 'pingpong':
        tile(...outBlock(), [[0, 0.5, from, to], [0.5, 1, to, from]])
        break
      case 'hold':
        segments.push({ p0, p1, s0: from, s1: from, kind })
        break
      case 'speed': {
        const rate = opt(r.rate) ?? 1
        segments.push({ p0, p1, s0: from, s1: from + rate * (p1 - p0), kind })
        break
      }
      case 'loop':
        tile(p0, p0 + Math.max(0, to - from), [[0, 1, from, to]])
        break
    }
  }
  segments.sort((a, b) => a.p0 - b.p0 || a.p1 - b.p1)
  return { segments, span: lb, loops }
}

// The compiled segments alone — what Table.retime warps content through.
export function timelineSegments(timelineRows: Row[], loopBeats: number = DEFAULT_LOOP_BEATS): TimelineSegment[] {
  return compile(timelineRows, loopBeats).segments
}

function sourceAt(segments: TimelineSegment[], p: number): number {
  for (const seg of segments) {
    if (p < seg.p0) break // sorted by p0 — we're in a gap, which plays unmapped
    if (p <= seg.p1) {
      const f = seg.p1 === seg.p0 ? 0 : (p - seg.p0) / (seg.p1 - seg.p0)
      return seg.s0 + (seg.s1 - seg.s0) * f
    }
  }
  return p
}

export interface BeatPlacement {
  // Playback beat the source beat lands on.
  beat: number
  // Local playback-per-source rate — what a `dur` stretches by (1 in a hold).
  stretch: number
}

// Invert the map: every playback beat at which source beat `b` is shown, one
// entry per segment that plays it — a loop event yields one per cycle. Source
// intervals are half-open (a cycle's end belongs to the next cycle) except at
// the timeline's very end, so segment joins don't double-place a beat.
export function placeBeat(segments: TimelineSegment[], b: number): BeatPlacement[] {
  const out: BeatPlacement[] = []
  const lastEnd = segments.reduce((m, s) => Math.max(m, s.p1), -Infinity)
  for (const seg of segments) {
    if (seg.s1 === seg.s0) {
      if (b === seg.s0) out.push({ beat: seg.p0, stretch: 1 })
      continue
    }
    const t = (b - seg.s0) / (seg.s1 - seg.s0)
    if (t >= 0 && (t < 1 || (t <= 1 && seg.p1 === lastEnd))) {
      out.push({
        beat: seg.p0 + t * (seg.p1 - seg.p0),
        stretch: Math.abs((seg.p1 - seg.p0) / (seg.s1 - seg.s0)),
      })
    }
  }
  return out
}

export function buildTimeline(timelineRows: Row[], loopBeats: number = DEFAULT_LOOP_BEATS): Timeline {
  const { segments, span, loops } = compile(timelineRows, loopBeats)
  if (!segments.length) {
    return { active: false, beats: 0, loops: 1, sourceBeatAt: (pb) => pb }
  }
  return {
    active: true,
    beats: span,
    loops,
    sourceBeatAt(playbackBeat: number, loop = 0): number {
      const p = playbackBeat + (loops > 1 ? (loop % loops) * span : 0)
      return sourceAt(segments, p)
    },
  }
}
