// eventable particles — the pure table side of the GPU particle system
// (compute/particles.ts is the stateful GPU sim). A view named "particles"
// opts the sim in: a `spawn` row turns it on, and `setVariable` rows fold onto
// the sim's parameters at-or-before the playhead like every other event table.
// The sim itself cannot be baked or scrubbed; only its controls live here.
import { beatToFrame } from './constants.js'
import type { Row } from './lineage.js'

const PARTICLE_EVENTS = new Set(['spawn', 'setVariable'])

export function isParticleRow(row: Row | null | undefined): boolean {
  return row != null && typeof row.event === 'string' && PARTICLE_EVENTS.has(row.event)
}

export function particleRows(rows: Row[] | null | undefined): Row[] {
  return (rows ?? []).filter((r) => isParticleRow(r) && r.disabled !== true)
}

// The sim runs iff the table declares at least one enabled spawner.
export function hasSpawner(rows: Row[]): boolean {
  return rows.some((r) => r.event === 'spawn')
}

export const PARTICLE_PARAM_NAMES = ['timeMultiplier', 'elscale', 'speed'] as const
export type ParticleParamName = (typeof PARTICLE_PARAM_NAMES)[number]

// Fold `setVariable` rows at-or-before frame `f`: last write per known name wins.
export function particleParamsAt(rows: Row[], f: number): Partial<Record<ParticleParamName, number>> {
  const out: Partial<Record<ParticleParamName, number>> = {}
  const sets = rows
    .filter((r) => r.event === 'setVariable' && typeof r.name === 'string' && typeof r.value === 'number')
    .map((r) => ({ row: r, index: beatToFrame((r.beat as number | undefined) ?? 1) }))
    .sort((a, b) => a.index - b.index)
  for (const { row, index } of sets) {
    if (index > f) break
    if ((PARTICLE_PARAM_NAMES as readonly string[]).includes(row.name as string)) {
      out[row.name as ParticleParamName] = row.value as number
    }
  }
  return out
}
