// Paper-clearance metric: does the displayed paper pass through itself?
// Measures what the renderer draws — foldTablePositions' vertices with each
// face's layer offset applied, fan-triangulated as in three-scene.ts. Offences:
// crossings (paper through paper), depth (penetration past the other face's
// plane), shears (near-coplanar overlap the layer offsets fail to separate).
import { foldTablePositions, type FoldTableProgram } from '../../src/fold-engine.js'
import { triCrossDepth, triShearArea, type V3 } from '../../src/tri-clearance.js'

export interface ClearanceFrame {
  fold: number
  shearArea: number     // near-coplanar unseparated overlap area
  depth: number         // deepest mutual plane penetration among crossing pairs
  worstPair?: [number, number]
}

// displayed triangles at one fold value, grouped per face
const displayTris = (program: FoldTableProgram, fold: number): {
  FV: number[][]; tris: [V3, V3, V3][][]; bboxes: [V3, V3][]
} => {
  const { FV, pos, zOff, zDir } = foldTablePositions(program, fold)
  const tris: [V3, V3, V3][][] = []
  const bboxes: [V3, V3][] = []
  FV.forEach((F, fi) => {
    const d = zDir?.[fi] ?? [0, 0, 1]
    const off: V3 = [d[0] * zOff[fi], d[1] * zOff[fi], d[2] * zOff[fi]]
    const own: [V3, V3, V3][] = []
    const lo: V3 = [Infinity, Infinity, Infinity]
    const hi: V3 = [-Infinity, -Infinity, -Infinity]
    const at = (vi: number): V3 => [pos[vi][0] + off[0], pos[vi][1] + off[1], pos[vi][2] + off[2]]
    for (let j = 1; j + 1 < F.length; ++j) own.push([at(F[0]), at(F[j]), at(F[j + 1])])
    for (const vi of F) {
      const p = at(vi)
      for (let c = 0; c < 3; ++c) { lo[c] = Math.min(lo[c], p[c]); hi[c] = Math.max(hi[c], p[c]) }
    }
    tris.push(own)
    bboxes.push([lo, hi])
  })
  return { FV, tris, bboxes }
}

export const clearanceAt = (
  program: FoldTableProgram, fold: number, opts: { shearGapFrac?: number } = {},
): ClearanceFrame => {
  const { FV, tris, bboxes } = displayTris(program, fold)
  const gapMin = program.gap * (opts.shearGapFrac ?? 0.25)
  const shares = (a: number[], b: number[]): boolean => a.some((v) => b.includes(v))
  let shearArea = 0
  let depth = 0
  let worstPair: [number, number] | undefined
  for (let a = 0; a < FV.length; ++a) {
    for (let b = a + 1; b < FV.length; ++b) {
      if (shares(FV[a], FV[b])) continue // joined at a crease — legitimately touch
      const [alo, ahi] = bboxes[a]
      const [blo, bhi] = bboxes[b]
      if (alo[0] > bhi[0] + gapMin || blo[0] > ahi[0] + gapMin ||
          alo[1] > bhi[1] + gapMin || blo[1] > ahi[1] + gapMin ||
          alo[2] > bhi[2] + gapMin || blo[2] > ahi[2] + gapMin) continue
      for (const t1 of tris[a]) {
        for (const t2 of tris[b]) {
          shearArea += triShearArea(t1, t2, gapMin)
          const d = triCrossDepth(t1, t2)
          if (d > depth) { depth = d; worstPair = [a, b] }
        }
      }
    }
  }
  return { fold, shearArea, depth, worstPair }
}
