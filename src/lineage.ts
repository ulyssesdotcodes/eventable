// Provenance tags on rows: every derived row can carry a hidden tag recording
// which source rows it came from. A ref's `index` is the row's ordinal within
// that named view — exactly how the table/graph panels address rows. The tag
// lives under a Symbol key: enumerable, so it rides along through `{ ...row }`
// spreads, but invisible to Object.keys and JSON.stringify.

// Unique-symbol trick: cast the runtime Symbol.for value so TypeScript accepts
// it as a computed property key in interfaces and object types.
declare const _lineageUnique: unique symbol
type LineageSymbol = typeof _lineageUnique

export const LINEAGE = Symbol.for('eventable.lineage') as unknown as LineageSymbol

export type Row = Record<string, unknown>

export interface LineageRef {
  table: string
  index: number
}

type TaggedRow = Row & { [LINEAGE]?: LineageRef[] }

export function getLineage(row: Row): LineageRef[] {
  return (row as TaggedRow)[LINEAGE] ?? []
}

export function withLineage<T extends Row>(row: T, refs: LineageRef[]): T {
  if (refs && refs.length) (row as TaggedRow)[LINEAGE] = refs
  return row
}

export function carry(row: Row): LineageRef[] {
  return [...getLineage(row)]
}

export function unionLineage(rows: Row[]): LineageRef[] {
  const out: LineageRef[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    for (const ref of getLineage(r)) {
      const key = ref.table + ' ' + ref.index
      if (!seen.has(key)) {
        seen.add(key)
        out.push(ref)
      }
    }
  }
  return out
}

export function activeLineage(rows: Row[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>()
  for (const r of rows ?? []) {
    for (const ref of getLineage(r)) {
      if (!map.has(ref.table)) map.set(ref.table, new Set())
      map.get(ref.table)!.add(ref.index)
    }
  }
  return map
}
