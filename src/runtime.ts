// The cook network: a reactive dataflow engine over named views (à la Houdini
// node cooking). Cooking builds a lazy op-graph (see dsl.ts) without computing
// rows; materialization then reuses a previous run's rows whenever a node's
// content hash is unchanged, so untouched subgraphs aren't re-baked.

import {
  createDSL, Table, materialize, fnv1a, outViewName,
  type ViewFn, type DSLContext, type GraphSpec, type PhysicsEngine, type Memo, type MatCtx,
} from './dsl.js'
import { evalRowExprCells } from './expr-cell.js'
import { getLineage, withLineage, type Row } from './lineage.js'
import type { ColumnType } from './editable-tables.js'

type DefEntry =
  | { kind: 'lazy'; fn: ViewFn }
  | { kind: 'const'; table: Table }
  | { kind: 'group'; members: string[] }

export interface RuntimeResult {
  views: Map<string, Table>
  graphs: GraphSpec[]
  deps: Map<string, string[]>
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Flattens inputs and sorts by beat — shared by the 'group' and 'out' node
// kinds, which both just concatenate their member tables in beat order.
const beatSorted = (ins: Row[][]): Row[] => {
  const rows: Row[] = ins.flat()
  rows.sort((a, b) => ((a.beat as number) ?? 1) - ((b.beat as number) ?? 1))
  return rows
}

export interface RuntimeOptions {
  physics?: () => PhysicsEngine | null
  tapRows?: () => Row[] | null
  editableRows?: (name: string, schema: Record<string, ColumnType>, seedRows?: Row[]) => Row[]
  // The streaming log tables — the read-only event histories the table panel
  // shows ("code·events", "activity", "midi·events", …). Consulted only when
  // table(name) matches no defined view, so a program can read its own session's
  // logs as ordinary data (null/undefined = no such log, keep the not-found
  // error). Mirrors the display rule: a program view of the same name wins.
  logRows?: (name: string) => Row[] | null | undefined
  // expr.slider(name, min, max) declarations — see DSLContext.defineSlider.
  defineSlider?: (id: string, min?: number, max?: number) => void
}

export interface RunOptions {
  seed?: number
  dataCache?: Map<string, string>
}

export function createRuntime({ physics, tapRows, editableRows, logRows, defineSlider }: RuntimeOptions = {}): { run: (code: string, opts?: RunOptions) => RuntimeResult } {
  let defs: Map<string, DefEntry>
  let cache: Map<string, Table>
  let deps: Map<string, string[]>
  let graphs: GraphSpec[]
  let seedVal: number
  let prngs: Map<string, () => number>
  let groups: Map<string, string[]>
  let outs: Map<string, Table[]>
  let currentCookingView: string | null = null
  let dataCache = new Map<string, string>()

  // Cross-run row cache keyed by content hash, two generations: a result
  // survives one run of non-use before eviction — bounds memory while still
  // catching same-as-last-run subgraphs.
  let curMemo = new Map<number, Row[]>()
  let prevMemo = new Map<number, Row[]>()
  const memo: Memo = {
    get: (h) => curMemo.get(h) ?? prevMemo.get(h),
    set: (h, rows) => { curMemo.set(h, rows) },
  }

  function randForView(name: string): () => number {
    if (!prngs.has(name)) prngs.set(name, mulberry32((seedVal ^ fnv1a(name)) >>> 0))
    return prngs.get(name)!
  }

  // Appends this view's provenance ref to each row's lineage when materialized.
  function stampNode(name: string, input: Table): Table {
    return Table._fromNode(ctx, {
      op: 'stamp',
      spec: { name },
      inputs: [input],
      seedSensitive: false,
      compute: (ins) => ins[0].map((r, index) =>
        withLineage({ ...r }, [...getLineage(r), { table: name, index }])),
    })
  }

  function cook(name: string, callerView: string | null, stack: string[]): Table {
    if (cache.has(name)) {
      if (callerView) deps.get(callerView)?.push(name)
      return cache.get(name)!
    }
    const def = defs.get(name)
    if (!def) {
      // Not a defined view — maybe a streaming log table (see RuntimeOptions.
      // logRows): serve a snapshot of its rows as a const table, so the session's
      // own history ("code·events", "activity", …) reads like any other data.
      const log = logRows?.(name)
      if (log) {
        if (callerView) deps.get(callerView)?.push(name)
        const stamped = stampNode(name, new Table(log.map((r) => ({ ...r })), ctx))
        cache.set(name, stamped)
        return stamped
      }
      throw new Error(`table("${name}") not found — define("${name}", (rand, table) => ...) it first`)
    }
    if (stack.includes(name)) {
      throw new Error(`cycle in cook: ${[...stack, name].join(' -> ')}`)
    }
    if (callerView) deps.get(callerView)?.push(name)

    if (def.kind === 'const') {
      const stamped = stampNode(name, def.table)
      cache.set(name, stamped)
      return stamped
    }

    if (def.kind === 'group') {
      if (!deps.has(name)) deps.set(name, [])
      const groupStack = [...stack, name]
      const members = def.members.map((m) => cook(m, name, groupStack))
      const groupT = Table._fromNode(ctx, {
        op: 'group',
        spec: { members: def.members },
        inputs: members,
        seedSensitive: false,
        compute: beatSorted,
      })
      const stamped = stampNode(name, groupT)
      cache.set(name, stamped)
      return stamped
    }

    if (!deps.has(name)) deps.set(name, [])
    const nextStack = [...stack, name]
    const rand = randForView(name)
    const localTable = (dep: string) => cook(dep, name, nextStack)
    const prevCooking = currentCookingView
    currentCookingView = name
    const raw = def.fn(rand, localTable)
    currentCookingView = prevCooking
    const result = raw instanceof Table
      ? raw
      : new Table(Array.isArray(raw) ? (raw as Row[]).map((r) => ({ ...r })) : [], ctx)
    const stamped = stampNode(name, result)
    cache.set(name, stamped)
    return stamped
  }

  const ctx: DSLContext = {
    defineLazy(name: string, fn: ViewFn, group?: string): void {
      defs.set(name, { kind: 'lazy', fn })
      if (group) {
        if (!groups.has(group)) groups.set(group, [])
        groups.get(group)!.push(name)
      }
    },
    defineConst(name: string, table: Table): void {
      defs.set(name, { kind: 'const', table })
    },
    addGraph(spec: GraphSpec): void {
      graphs.push({ ...spec, viewName: currentCookingView })
    },
    addOut(kind: string, table: Table): void {
      if (!outs.has(kind)) outs.set(kind, [])
      const list = outs.get(kind)!
      if (!list.includes(table)) list.push(table)
    },
    resolve(name: string): Table {
      return cook(name, null, [])
    },
    physics: () => (physics ? physics() : null),
    tapRows: () => (tapRows ? tapRows() : null),
    getData: (url: string) => dataCache.get(url) ?? '',
    // "=" cells in number columns evaluate here, per row, inside the cook —
    // so a cell's expr.slider() declaration flows through ctx.defineSlider
    // like any code declaration. Lives on this wrapper (not dsl.editable) to
    // keep dsl.ts ↔ expr-cell.ts acyclic.
    editableRows: (name: string, schema: Record<string, ColumnType>, seedRows?: Row[]) =>
      evalRowExprCells(editableRows ? editableRows(name, schema, seedRows) : [], schema, api.expr),
    defineSlider: (id: string, min?: number, max?: number) => defineSlider?.(id, min, max),
  }

  const api = createDSL(ctx)
  const matCtx: MatCtx = { physics: () => (physics ? physics() : null) }

  function run(code: string, { seed = 0, dataCache: dc }: RunOptions = {}): RuntimeResult {
    defs = new Map()
    cache = new Map()
    deps = new Map()
    graphs = []
    prngs = new Map()
    groups = new Map()
    outs = new Map()
    seedVal = seed >>> 0
    ctx.seed = seedVal
    dataCache = dc ?? new Map()

    prevMemo = curMemo
    curMemo = new Map()

    const fn = new Function(...Object.keys(api), code) as (...args: unknown[]) => void
    fn(...Object.values(api))

    for (const [group, members] of groups) {
      defs.set(group, { kind: 'group', members })
    }

    for (const name of defs.keys()) cook(name, null, [])

    // Combined per-consumer output views: every table routed with .outX(),
    // concatenated beat-sorted (as groups are) under a "(system)" name (see
    // outViewName) — visible in the panel. Routing takes precedence: replay
    // reads this view and IGNORES a same-named view — the bare-name lookup is
    // only the no-routes backwards-compatibility fallback (see replay.ts).
    // Built after the def cook so routes made inside lazy view fns are
    // collected too.
    for (const [kind, members] of outs) {
      const name = outViewName(kind)
      const combined = Table._fromNode(ctx, {
        op: 'out',
        spec: { kind },
        inputs: members,
        seedSensitive: false,
        compute: beatSorted,
      })
      deps.set(name, [])
      cache.set(name, stampNode(name, combined))
    }

    for (const t of cache.values()) materialize(t, matCtx, memo)

    const resolvedGraphs = graphs.map((g) => ({
      table: g.viewName ? cache.get(g.viewName) ?? g.table : g.table,
      columns: g.columns,
      viewName: g.viewName ?? g.table.name,
    }))

    return { views: cache, graphs: resolvedGraphs, deps }
  }

  return { run }
}
