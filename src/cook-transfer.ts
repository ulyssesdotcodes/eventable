// Cook transfer — (de)serializing cooked results across the worker boundary.
// Three things in cooked rows don't survive structured clone: functions —
// packed as { $fn: source }, rehydrated with new Function (same trust domain
// as the already-evaluated program, but a lambda loses its closure captures);
// symbol-keyed row lineage — carried as a $lineage field; and Table instances
// — sent as { name, rows }.
//
// Identity still matters: a value a scene column holds for the whole run —
// the compiled origami program is megabytes — is one entry in the frame store,
// and pack/unpack memoize per object so it stays one object on the wire.

import { Table } from './dsl.js'
import { getLineage, withLineage, type Row } from './lineage.js'
import type { CookedResult, CookedSigs } from './replay.js'

const FN_KEY = '$fn'
const LINEAGE_KEY = '$lineage'

type Memo = Map<object, unknown>

// Typed arrays are structured-clone natives: walking them like a plain object
// would rebuild each one as { 0: …, 1: … }, which is both far larger on the
// wire and no longer a typed array on the other side.
const isTypedArray = (v: object): boolean => ArrayBuffer.isView(v) && !(v instanceof DataView)

function packValue(v: unknown, memo: Memo): unknown {
  if (typeof v === 'function') return { [FN_KEY]: String(v) }
  if (v === null || typeof v !== 'object') return v
  const hit = memo.get(v)
  if (hit !== undefined) return hit
  if (isTypedArray(v)) { memo.set(v, v); return v }
  if (Array.isArray(v)) {
    const out: unknown[] = []
    memo.set(v, out)
    for (let i = 0; i < v.length; ++i) out[i] = packValue(v[i], memo)
    return out
  }
  const out: Record<string, unknown> = {}
  memo.set(v, out)
  for (const k of Object.keys(v)) {
    out[k] = packValue((v as Record<string, unknown>)[k], memo)
  }
  return out
}

function unpackValue(v: unknown, memo: Memo): unknown {
  if (v === null || typeof v !== 'object') return v
  const hit = memo.get(v)
  if (hit !== undefined) return hit
  if (isTypedArray(v)) { memo.set(v, v); return v }
  if (Array.isArray(v)) {
    const out: unknown[] = []
    memo.set(v, out)
    for (let i = 0; i < v.length; ++i) out[i] = unpackValue(v[i], memo)
    return out
  }
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length === 1 && keys[0] === FN_KEY && typeof obj[FN_KEY] === 'string') {
    let fn: unknown
    try {
      fn = new Function(`return (${obj[FN_KEY] as string})`)()
    } catch {
      fn = undefined
    }
    memo.set(v, fn)
    return fn
  }
  const out: Record<string, unknown> = {}
  memo.set(v, out)
  for (const k of keys) out[k] = unpackValue(obj[k], memo)
  return out
}

export function packRows(rows: Row[], memo: Memo = new Map()): Row[] {
  return rows.map((row) => {
    const packed = packValue(row, memo) as Row
    const refs = getLineage(row)
    if (refs.length) packed[LINEAGE_KEY] = refs
    return packed
  })
}

export function unpackRows(rows: Row[], memo: Memo = new Map()): Row[] {
  return rows.map((packed) => {
    const { [LINEAGE_KEY]: refs, ...rest } = packed
    const row = unpackValue(rest, memo) as Row
    return refs ? withLineage(row, refs as ReturnType<typeof getLineage>) : row
  })
}

export interface PackedCook {
  views: Array<{ name: string; rows: Row[] }>
  // rows: null points at a packed view by name; an anonymous .graph(table)
  // target carries its own rows.
  graphs: Array<{ viewName: string | null; columns: string[]; rows: Row[] | null }>
  scene: unknown
  timelineRows: Row[]
  hydraRows: Row[]
  baubleRows: Row[]
  postRows: Row[]
  sigs: CookedSigs
}

export function packCooked(cooked: CookedResult): PackedCook {
  // One memo for the whole payload: an object shared across views and the
  // scene rows (the compiled origami program) stays one object on the wire.
  const memo: Map<object, unknown> = new Map()
  const views = [...cooked.views].map(([name, table]) => ({ name, rows: packRows(table.rows, memo) }))
  const graphs = cooked.graphs.map((g) => {
    const viewName = g.viewName ?? g.table.name ?? null
    const isView = viewName != null && cooked.views.has(viewName)
    return { viewName, columns: g.columns, rows: isView ? null : packRows(g.table.rows, memo) }
  })
  return {
    views,
    graphs,
    scene: packValue(cooked.scene, memo),
    timelineRows: packRows(cooked.timelineRows, memo),
    hydraRows: packRows(cooked.hydraRows, memo),
    baubleRows: packRows(cooked.baubleRows, memo),
    postRows: packRows(cooked.postRows, memo),
    sigs: cooked.sigs,
  }
}

export function unpackCooked(packed: PackedCook): CookedResult {
  const memo: Map<object, unknown> = new Map()
  const views = new Map<string, Table>()
  for (const { name, rows } of packed.views) {
    const t = new Table(unpackRows(rows, memo))
    t.name = name
    views.set(name, t)
  }
  const graphs = packed.graphs.map((g) => {
    const table = (g.viewName != null ? views.get(g.viewName) : undefined) ?? new Table(unpackRows(g.rows ?? [], memo))
    return { table, columns: g.columns, viewName: g.viewName }
  })
  return {
    views,
    graphs,
    scene: unpackValue(packed.scene, memo) as CookedResult['scene'],
    timelineRows: unpackRows(packed.timelineRows, memo),
    hydraRows: unpackRows(packed.hydraRows, memo),
    // ?? tolerates a stale worker bundle from before bauble/post/sigs existed.
    baubleRows: unpackRows(packed.baubleRows ?? [], memo),
    postRows: unpackRows(packed.postRows ?? [], memo),
    sigs: packed.sigs ?? { scene: '', timeline: '', hydra: '', bauble: '', post: '' },
  }
}
