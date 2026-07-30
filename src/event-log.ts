// The shared append-only primitive under everything authored live: state is
// never stored, only folded from stamped events. Also the multiplayer unit:
// seq doubles as a Lamport clock and (seq, src) is a deterministic total
// order, so any two replicas that have seen the same events fold to the same
// state.

export interface StampedEvent {
  seq: number
  t: number
  kind: string
  src?: string
  [key: string]: unknown
}

export interface EventPayload {
  kind: string
  [key: string]: unknown
}

interface SerializedEvents {
  version: number
  start: number | null
  events: StampedEvent[]
}

/**
 * Upgrades an event list from one serialized version to the next, on load, so
 * folds only ever see the current shape. The chain is positional —
 * migrations[i] upgrades v(i+1) to v(i+2) — so append new migrations, never
 * edit or reorder existing ones: old data on disk depends on them.
 */
export type EventMigration = (events: StampedEvent[]) => StampedEvent[]

// A log with no migrations serializes at version 1; each migration adds one.
const BASE_VERSION = 1

// ---------------------------------------------------------------------------
// Replica identity + merge — the pure pieces multiplayer is built from.
// ---------------------------------------------------------------------------

// Replica id, minted once per page load. Deliberately NOT persisted: two tabs
// of one browser must be distinct replicas, or their (src, seq) keys would
// collide and merge() would drop real events as duplicates.
let cachedSource: string | null = null

export function localSource(): string {
  cachedSource ??= 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  return cachedSource
}

/** Deterministic total order (seq, then src) — same sort on every replica, same fold. */
export function compareEvents(a: { seq: number; src?: string }, b: { seq: number; src?: string }): number {
  if (a.seq !== b.seq) return a.seq - b.seq
  const as = a.src ?? '', bs = b.src ?? ''
  return as < bs ? -1 : as > bs ? 1 : 0
}

/** The (src, seq) identity key — the multiplayer dedup unit and the form apply `edits` lists hold. */
export const eventKey = (e: StampedEvent): string => `${e.src ?? ''}#${e.seq}`

/**
 * Compaction for latest-wins logs (presence — see presence.ts): keeps only the
 * newest event per (src, kind), bounding the log to O(replicas × kinds). Never
 * use on a log whose fold replays history — compaction would destroy it.
 */
export function compactLatestPerSrcKind(events: StampedEvent[]): StampedEvent[] {
  const latest = new Map<string, StampedEvent>()
  for (const e of events) {
    const key = `${e.src ?? ''}#${e.kind}`
    const cur = latest.get(key)
    if (!cur || compareEvents(cur, e) < 0) latest.set(key, e)
  }
  if (latest.size === events.length) return events
  return events.filter((e) => latest.get(`${e.src ?? ''}#${e.kind}`) === e)
}

/**
 * Union `incoming` into `existing`, deduping by (src, seq). Pure — shared by
 * EventLog.merge and the multiplayer server's room state.
 */
export function mergeEvents(
  existing: StampedEvent[],
  incoming: StampedEvent[],
): { events: StampedEvent[]; added: StampedEvent[] } {
  const seen = new Set(existing.map(eventKey))
  const added: StampedEvent[] = []
  for (const e of incoming) {
    if (!e || typeof e.seq !== 'number' || typeof e.kind !== 'string') continue
    const key = eventKey(e)
    if (seen.has(key)) continue
    seen.add(key)
    added.push({ ...e })
  }
  if (!added.length) return { events: existing, added }
  return { events: [...existing, ...added].sort(compareEvents), added }
}

export interface EventLog {
  append(payload: EventPayload): StampedEvent
  all(): StampedEvent[]
  upTo(pos: number): StampedEvent[] // events with seq <= pos
  last(): StampedEvent | null
  readonly length: number
  onChange(cb: () => void): void
  // Fired only for locally-authored appends — the multiplayer publish hook.
  onAppend(cb: (e: StampedEvent) => void): void
  // Integrate other replicas' events, bumping the local clock past everything
  // seen. Returns the events that were actually new.
  merge(incoming: StampedEvent[]): StampedEvent[]
  // Merged events can land *between* existing ones, so consumers should
  // refold rather than apply incrementally.
  onMerge(cb: (added: StampedEvent[]) => void): void
  serialize(): string
  load(json: string | unknown): boolean
  clear(): void
}

export function createEventLog(
  { src = localSource(), migrations = [], compact }: {
    src?: string
    migrations?: EventMigration[]
    // Compaction applied after every append/merge/load. The seq counter is
    // independent of the events list, so pruning never re-mints a (src, seq)
    // key; but a pruned event can be re-merged later, so folds over compactable
    // logs must tolerate stale re-deliveries (latest-wins folds do).
    compact?: (events: StampedEvent[]) => StampedEvent[]
  } = {},
): EventLog {
  const serialVersion = BASE_VERSION + migrations.length
  let events: StampedEvent[] = []
  let seq = 0
  let start: number | null = null
  const listeners: (() => void)[] = []
  const appendListeners: ((e: StampedEvent) => void)[] = []
  const mergeListeners: ((added: StampedEvent[]) => void)[] = []

  const notify = (): void => listeners.forEach((cb) => cb())

  return {
    append(payload: EventPayload): StampedEvent {
      if (start == null) start = Date.now()
      // A payload src overrides the replica id — content-derived identity
      // (e.g. 'slider:<name>'), so the same declaration re-generated on
      // another replica or a later run reads as the same author.
      const event: StampedEvent = {
        ...payload, seq: seq++, t: Date.now() - start,
        src: typeof payload.src === 'string' && payload.src !== '' ? payload.src : src,
      }
      events.push(event)
      if (compact) events = compact(events)
      appendListeners.forEach((cb) => cb(event))
      notify()
      return event
    },

    all: () => events.slice(),

    upTo: (pos: number) => events.filter((e) => e.seq <= pos),

    last: () => (events.length ? events[events.length - 1] : null),

    get length() { return events.length },

    onChange(cb: () => void): void {
      listeners.push(cb)
    },

    onAppend(cb: (e: StampedEvent) => void): void {
      appendListeners.push(cb)
    },

    merge(incoming: StampedEvent[]): StampedEvent[] {
      const { events: merged, added } = mergeEvents(events, incoming)
      if (!added.length) return added
      events = compact ? compact(merged) : merged
      seq = merged.reduce((m, e) => Math.max(m, e.seq + 1), seq)
      if (start == null) start = Date.now()
      mergeListeners.forEach((cb) => cb(added))
      notify()
      return added
    },

    onMerge(cb: (added: StampedEvent[]) => void): void {
      mergeListeners.push(cb)
    },

    serialize(): string {
      return JSON.stringify({ version: serialVersion, start, events } satisfies SerializedEvents)
    },

    load(json: string | unknown): boolean {
      try {
        const data = typeof json === 'string' ? JSON.parse(json) as SerializedEvents : json as SerializedEvents
        if (!data || !Array.isArray(data.events)) return false
        // Run the tail of the migration chain. An absent/out-of-range version
        // reads as base; data from a newer build is loaded as-is (best effort).
        const from = typeof data.version === 'number' && data.version >= BASE_VERSION ? data.version : BASE_VERSION
        let migrated = data.events.map((e) => ({ ...e }))
        for (let v = from; v < serialVersion; v++) migrated = migrations[v - BASE_VERSION](migrated)
        events = compact ? compact(migrated) : migrated
        start = data.start ?? null
        seq = migrated.reduce((m, e) => Math.max(m, (e.seq ?? -1) + 1), 0)
        notify()
        return true
      } catch {
        return false
      }
    },

    clear(): void {
      events = []
      seq = 0
      start = null
      notify()
    },
  }
}

/** Unsigned 32-bit run seed for the DSL's per-view PRNGs (see runtime.ts). */
export function randomSeed(): number {
  return (Math.random() * 0x100000000) >>> 0
}
