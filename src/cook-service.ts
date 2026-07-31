// Cook service — the worker side of off-main-thread cooking. handle() is a
// pure request → response function (cook-worker.ts wires it to postMessage) so
// node tests can drive it directly; the runtime persists across requests to
// keep the materialize memo warm. The store stays on the main thread, so each
// request carries editable-table snapshots, and editable() calls during the
// cook are reported back as `declared` for the main thread's real ensure().

import { createRuntime } from './runtime.js'
import { cookProgram } from './replay.js'
import { sliderDeclsInCode } from './post-lang.js'
import { exprSliderDecls } from './expr-cell.js'
import { conformRow, schemaColumns, EVENTS_SUFFIX, type Schema } from './editable-tables.js'
import { packCooked, type PackedCook } from './cook-transfer.js'
import { DEFAULT_LOOP_BEATS } from './constants.js'
import type { PhysicsEngine } from './dsl.js'
import type { Row } from './lineage.js'

export interface CookRequest {
  id: number
  code: string
  seed: number
  dataCache: Array<[string, string]>
  tapRows: Row[]
  // The GUI loop length — the pass length cook-time .retime() warps within.
  loopBeats?: number
  // Rows of every editable table, folded through any active replay view —
  // exactly what ensure() would serve on the main thread.
  editables: Array<{ name: string; rows: Row[] }>
  // Seed rows for editable tables the store hasn't seen yet, keyed by name —
  // set when an example's table data lives with the sample rather than inline
  // in the program; ignored once the table exists in the snapshot.
  seeds?: Record<string, Row[]>
  // The streaming log tables under their display names ("code·events",
  // "activity", "midi·events", …) — see main.ts's logTables(). table(name) in
  // the program falls back to these when no view defines the name, so a sketch
  // can read the session's own history as data (RuntimeOptions.logRows).
  logs?: Array<{ name: string; rows: Row[] }>
}

// An editable() declared during the cook; the main thread applies these
// through the store's real ensure().
export interface DeclaredEditable {
  name: string
  schema: Schema
  seedRows?: Row[]
}

// A slider declared by the cooked program — expr.slider(name, min, max), or a
// slider(name, min, max) call in a post code cell. One entry per name (the
// last declaration wins); the main thread applies each through the store's
// defineSlider(), so every run logs its declarations.
export interface DeclaredSlider {
  id: string
  min?: number
  max?: number
}

export type CookResponse =
  | { id: number; ok: true; cooked: PackedCook; declared: DeclaredEditable[]; sliders: DeclaredSlider[] }
  | { id: number; ok: false; error: string }

export interface CookService {
  handle(req: CookRequest): CookResponse
}

export function createCookService({ physics }: { physics?: () => PhysicsEngine | null } = {}): CookService {
  let snapshot = new Map<string, Row[]>()
  let logs = new Map<string, Row[]>()
  let taps: Row[] = []
  let loopBeats = DEFAULT_LOOP_BEATS
  let seeds: Record<string, Row[]> = {}
  let declared: DeclaredEditable[] = []
  let sliders = new Map<string, DeclaredSlider>()

  const runtime = createRuntime({
    physics: physics ?? (() => null),
    tapRows: () => taps,
    loopBeats: () => loopBeats,
    logRows: (name) => logs.get(name) ?? null,
    editableRows: (name, schema, seedRows) => {
      // Inline seedRows win over an example-provided seed; reporting the
      // effective seed in `declared` lets the main thread's ensure() create
      // the table with those rows.
      const seed = seedRows ?? seeds[name]
      declared.push({ name, schema, ...(seed !== undefined ? { seedRows: seed } : {}) })
      // Declaring a table guarantees its history stream: the very first cook of
      // a fresh editable runs before the store has recorded anything, so its
      // "name·events" log must read as empty rather than table-not-found.
      const eventsName = name + EVENTS_SUFFIX
      if (!logs.has(eventsName)) logs.set(eventsName, [])
      const existing = snapshot.get(name)
      if (existing) return existing
      return (seed ?? []).map((r) => conformRow(r, schemaColumns(schema)))
    },
    defineSlider: (id, min, max) => {
      sliders.set(id, { id, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) })
    },
  })

  return {
    handle(req: CookRequest): CookResponse {
      snapshot = new Map(req.editables.map((e) => [e.name, e.rows]))
      logs = new Map((req.logs ?? []).map((l) => [l.name, l.rows]))
      taps = req.tapRows
      loopBeats = req.loopBeats ?? DEFAULT_LOOP_BEATS
      seeds = req.seeds ?? {}
      declared = []
      sliders = new Map()
      try {
        const cooked = cookProgram(runtime, req.code, req.seed, new Map(req.dataCache))
        // Post cells run per frame on the main thread, so their slider
        // declarations are collected here, once per run, like expr.slider's.
        for (const row of cooked.postRows) {
          if (typeof row.code !== 'string' || row.code.trim() === '') continue
          for (const d of sliderDeclsInCode(row.code)) sliders.set(d.id, d)
        }
        // Hydra cells can't be evaluated here (sketches compile in the browser
        // against hydra's generators), so expr.slider declarations are matched
        // textually.
        for (const row of cooked.hydraRows) {
          if (typeof row.code !== 'string' || row.code.trim() === '') continue
          for (const d of exprSliderDecls(row.code)) sliders.set(d.id, d)
        }
        return { id: req.id, ok: true, cooked: packCooked(cooked), declared, sliders: [...sliders.values()] }
      } catch (err) {
        return { id: req.id, ok: false, error: (err as Error).message }
      }
    },
  }
}
