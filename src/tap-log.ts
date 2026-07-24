// eventable tap-beat log — event-sourced ("tap"/"clear" events) so it syncs
// over multiplayer like any other table; the tap-beat table and derived tempo
// are folds of the log. Taps are stamped with wall-clock Date.now() (not
// performance.now(), which is meaningless across processes) so presses from
// different replicas fold into one chronological sequence.

import { createEventLog, type EventLog } from './event-log.js'
import type { Row } from './lineage.js'

const TAP_RESET_GAP_MS = 2000 // a long pause starts a fresh tempo
const TAP_MAX = 16            // keep a rolling window so BPM tracks recent tapping

export interface TapLog {
  // The underlying event log — the unit multiplayer syncs.
  readonly log: EventLog
  tap(): void
  clear(): void
  // One row per press in the current window — { beat, time }, time as the
  // press's absolute UTC epoch ms (not time-since-first-tap), so a joining
  // client derives the same tempo and wall-clock reference with no extra sync.
  rows(): Row[]
  // The epoch (ms) "beat 0" anchors to, once two taps establish a tempo; null
  // otherwise. It's the *first* tap of the sequence — the one that actually
  // landed on the grid; later taps only refine the interval.
  anchor(): number | null
}

export function createTapLog({ src }: { src?: string } = {}): TapLog {
  const log = createEventLog({ src })

  // Folded in wall-clock order: merged taps from another replica can land out
  // of the log's (seq, src) order, but the reset-gap/window logic cares about
  // when presses actually happened.
  function window(): number[] {
    const events = log.all()
      .filter((e) => e.kind === 'tap' || e.kind === 'clear')
      .sort((a, b) => (a.at as number ?? 0) - (b.at as number ?? 0))
    let times: number[] = []
    for (const e of events) {
      if (e.kind === 'clear') { times = []; continue }
      const at = e.at as number
      if (times.length && at - times[times.length - 1] > TAP_RESET_GAP_MS) times = []
      times.push(at)
      if (times.length > TAP_MAX) times = times.slice(-TAP_MAX)
    }
    return times
  }

  return {
    log,
    tap(): void { log.append({ kind: 'tap', at: Date.now() }) },
    clear(): void { log.append({ kind: 'clear', at: Date.now() }) },
    rows(): Row[] {
      return window().map((t, i) => ({ beat: i, time: t }))
    },
    anchor(): number | null {
      const times = window()
      return times.length >= 2 ? times[0] : null
    },
  }
}

// Average seconds between consecutive taps (row `time` is absolute epoch ms),
// or null with fewer than two. The one place the taps table turns into a beat
// length — DSL tempo()/beats() and the engine's beat clock all derive from it.
export function beatSecondsFromTaps(rows: Row[] | null | undefined): number | null {
  if (!rows || rows.length < 2) return null
  const first = rows[0].time as number
  const last = rows[rows.length - 1].time as number
  return (last - first) / (rows.length - 1) / 1000
}
