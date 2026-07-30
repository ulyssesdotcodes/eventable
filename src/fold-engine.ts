// Fold engine: a table of fold steps evaluated as exact flat-folded states.
// Each step splits faces along a line drawn in one stable world frame,
// reflects the selected flaps, and solves the layer order exactly via the
// vendored flat-folder core (seeded with the previous state's order).
// Faces share vertex indices, so the sheet can never tear; between states
// the motion is a rigid rotation of the moving flaps about the fold line.
import { M } from './vendor/flatfolder/math.js'
import { X } from './vendor/flatfolder/conversion.js'
import { CON } from './vendor/flatfolder/constraints.js'
import { NOTE } from './vendor/flatfolder/note.js'
import { COMP, TYPE_LABEL } from './vendor/linefolder/compute.js'
import { buildSoftMesh, bakeSoftMotion, pickPinned, FLAT_ANGLE } from './fold-relax.js'
import { buildReverseMech, reverseRecordOf, type ReverseRecord } from './fold-mech.js'
import { bakedMotionDepth } from './tri-clearance.js'

NOTE.show = false
let conBuilt = false
const ensureCon = (): void => {
  if (!conBuilt) { CON.build(); conBuilt = true }
}

export type Vec2 = [number, number]
export type Line = [Vec2, number] // unit normal u, offset d: dot(u, x) = d
export type FaceOrder = [number, number, number]

export interface FoldState {
  V: Vec2[]             // folded coords per vertex (stable world frame)
  FV: number[][]        // faces as vertex index loops
  FO: FaceOrder[]       // pairwise layer order [f, g, ±1]
  Ff: boolean[]         // per-face parity (true = face-down)
  sheet: Vec2[]         // unfolded sheet coords per vertex
  layers: number[]      // per-face layer index for display stacking
  eps: number
}

export interface FoldSpec {
  line: Line
  move: Vec2[]          // sheet-space marker points: which flaps move
  kind?: string         // filter states by classification (TYPE_LABEL)
  pick?: number         // index among matching states (sorted, default 0)
}

export interface FoldAnim {
  Vfrom: Vec2[]         // pre-fold coords (same indexing as state.V)
  moving: boolean[]     // per face
  line: Line
  // pre-fold stacking carried onto this step's faces (split pieces
  // inherit their parent's layer)
  layersFrom: number[]
  // rotation sense per face (0 for static): one sense per rigid flap,
  // voted from the solved layer order so it swings out on the side it
  // lands on; independent flaps can swing to opposite sides
  dirs: number[]
  // crease network for the soft solver: per-edge dihedral targets before
  // and after this fold (0 flat, ±FLAT folded, sign in the material frame)
  EV: [number, number][]
  angleFrom: number[]
  angleTo: number[]
}

export interface FoldOutcome {
  state: FoldState
  anim: FoldAnim
  type: string          // classification of the chosen state
  nStates: number       // how many valid layer orders existed
}

export class FoldError extends Error {}

export const KINDS: readonly string[] = TYPE_LABEL

export const lineThrough = (p1: Vec2, p2: Vec2): Line => {
  const len = M.dist(p1, p2)
  if (len < 1e-12) throw new FoldError('fold line needs two distinct points')
  let u = M.perp(M.div(M.sub(p2, p1), len)) as Vec2
  let d = M.dot(p1, u)
  if (d < 0) { u = M.mul(u, -1) as Vec2; d = -d }
  return [u, d]
}

const pointInPoly = (pt: Vec2, poly: Vec2[]): boolean => {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if ((yi > pt[1]) !== (yj > pt[1]) &&
        pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

const edgesOf = (FV: number[][]): [number, number][] => {
  const s = new Set<string>()
  for (const F of FV) {
    let i = F.length - 1
    for (let j = 0; j < F.length; ++j) { s.add(M.encode_order_pair([F[i], F[j]])); i = j }
  }
  return Array.from(s).sort().map((k) => M.decode(k))
}

// Total display order from the pairwise relation; undefined on cycles.
// Where the partial order leaves freedom, prefer the carried previous
// ranks (prio) so faces never swap display layers without a solved reason
// (gratuitous swaps make offset paths shimmer mid-swing).
const linearize = (H: Map<string, number>, n: number, prio: number[]): number[] | undefined => {
  const Adj: number[][] = Array(n).fill(0).map(() => [])
  const inDeg = Array(n).fill(0)
  for (const [k, o] of H) {
    if (o !== -1) continue
    const [f1, f2] = M.decode(k)
    Adj[f1].push(f2)
    inDeg[f2]++
  }
  // Kahn's, top face first; ties go to the previously highest face
  const idx = Array(n).fill(-1)
  const done = Array(n).fill(false)
  for (let i = 0; i < n; ++i) {
    let pick = -1
    for (let f = 0; f < n; ++f) {
      if (done[f] || inDeg[f] > 0) continue
      if (pick < 0 || prio[f] > prio[pick] || (prio[f] === prio[pick] && f < pick)) pick = f
    }
    if (pick < 0) return undefined // cycle
    idx[pick] = i
    done[pick] = true
    for (const g of Adj[pick]) inDeg[g]--
  }
  for (const [k, o] of H) {
    if (o !== -1) continue
    const [f1, f2] = M.decode(k)
    if (idx[f1] > idx[f2]) return undefined
  }
  // invert so bigger layer = higher in the stack (matches flat-folder's
  // per-cell display order)
  return idx.map((i) => n - 1 - i)
}

export const initialState = (corners?: Vec2[]): FoldState => {
  ensureCon()
  const V: Vec2[] = corners ?? [[0, 0], [1, 0], [1, 1], [0, 1]]
  const FV = [V.map((_, i) => i)]
  const [FOLD] = COMP.V_FV_2_FOLD_CELL(V.map((v) => [...v] as Vec2), FV)
  return {
    V: V.map((v) => [...v] as Vec2),
    FV,
    FO: [],
    Ff: FOLD.Ff,
    sheet: V.map((v) => [...v] as Vec2),
    layers: [0],
    eps: FOLD.eps,
  }
}

const MAX_STATES = 100000n

// Pre-creasing: cut every ply along the line without folding, giving
// later folds (and the soft solver) hinge lines to bend along.
export const creaseStep = (st: FoldState, line: Line): FoldState => {
  ensureCon()
  const [FVd, Vd, Sd, , F_map] = COMP.split_FOLD_on_line(
    { FV: st.FV, V: st.V, Vf: st.sheet, eps: st.eps }, line)
  const [FOLDn, CELLn] = COMP.V_FV_2_FOLD_CELL(Vd, FVd)
  const FO = COMP.map_order(CELLn.BI, F_map, st.FO) as FaceOrder[]
  const layers: number[] = FVd.map(() => 0)
  for (let parent = 0; parent < F_map.length; ++parent) {
    for (const piece of F_map[parent]) layers[piece] = st.layers[parent]
  }
  return {
    V: Vd as Vec2[], FV: FVd, FO, Ff: FOLDn.Ff,
    sheet: Sd as Vec2[], layers, eps: FOLDn.eps,
  }
}

export const foldStep = (st: FoldState, spec: FoldSpec): FoldOutcome => {
  ensureCon()
  const line = spec.line
  // 1. split every face crossing the line; sheet coords interpolate along
  const [FVd, Vd, Sd, VD, F_map] = COMP.split_FOLD_on_line(
    { FV: st.FV, V: st.V, Vf: st.sheet, eps: st.eps }, line)
  // 2. flap regions bounded by the line; markers select the moving ones
  const FG = COMP.get_groups(FVd, VD) as number[]
  const clicked = new Set<number>()
  for (const m of spec.move) {
    const fi = FVd.findIndex((F: number[]) => pointInPoly(m, F.map((i) => Sd[i])))
    if (fi < 0) throw new FoldError(`move point ${m[0]},${m[1]} is outside the sheet`)
    clicked.add(FG[fi])
  }
  const FM_ = FVd.map((_: number[], i: number) => clicked.has(FG[i]))
  if (!FM_.some(Boolean)) throw new FoldError('nothing moves: no flap selected')
  if (FM_.every(Boolean)) throw new FoldError('everything moves: the fold line must cross the model')
  // 3. re-merge faces cut only in passing; reflect the moving flaps
  const FRd = COMP.EF_FM_HC_2_FR_RF(
    X.EV_FV_2_EF_FE(edgesOf(FVd), FVd)[0], FM_, new Set())[0]
  const [Vx, FVy, FM, FOO, F_map2] = COMP.filter_clicked_and_reflect(
    Vd, st.FV, FVd, F_map, FM_, st.FO, FRd)
  const [Sy] = COMP.filter_clicked_and_reflect(
    Sd, st.FV, FVd, F_map, FM_, st.FO, FRd)
  const Vy = COMP.reflect(Vx, FVy, FM, line) as Vec2[]
  // 4. solve the layer order, seeded with surviving previous orders
  const [FOLDn, CELLn] = COMP.V_FV_2_FOLD_CELL(Vy, FVy)
  const { Ff, EV, EF, FE } = FOLDn
  const { BF, BI } = CELLn
  const FOcarry: FaceOrder[] = []
  for (const [f, g, o] of st.FO) {
    for (const f_ of F_map2[f]) {
      for (const g_ of F_map2[g]) {
        if (!BI.has(M.encode_order_pair([f_, g_]))) continue
        if (!FM[f_] && !FM[g_]) FOcarry.push([f_, g_, o])
      }
    }
  }
  const BA_map = new Map<string, number>()
  for (const [f, g, o] of FOcarry) {
    const a1 = (Ff[g] === (o > 0)) ? 1 : 2
    BA_map.set(M.encode_order_pair([f, g]), (f < g) ? a1 : ((a1 === 1) ? 2 : 1))
  }
  const BA0 = BF.map((s: string) => BA_map.get(s) ?? 0)
  const [GB, GA] = COMP.solve(FOLDn, CELLn, BA0)
  if (GA === undefined) {
    throw new FoldError('no valid folded state: this fold cannot lie flat')
  }
  const n = GA.reduce((s: bigint, A: number[]) => s * BigInt(A.length), 1n)
  if (n > MAX_STATES) throw new FoldError(`too many folded states to enumerate (${n})`)
  // 5. enumerate and classify the valid states; choose by kind/pick
  const Gn = GA.map((A: number[]) => A.length)
  const GI = GA.map(() => 0)
  const found: { gi: number[]; type: number; nRF: number; ord: number }[] = []
  for (let i = 0n; i < n; ++i) {
    const edges = X.BF_GB_GA_GI_2_edges(BF, GB, GA, GI)
    const FOi = X.edges_Ff_2_FO(edges, Ff) as FaceOrder[]
    const [type, RF] = COMP.classify(Vy, EV, EF, FE, Ff, FM, FOi, FOO)
    found.push({ gi: GI.map((x: number) => x), type, nRF: RF.length, ord: found.length })
    for (let j = 0; j < GI.length; ++j) {
      if (GI[j] !== Gn[j] - 1) { GI[j] += 1; break }
      GI[j] = 0
    }
  }
  let candidates = found
  if (spec.kind !== undefined) {
    const t = TYPE_LABEL.indexOf(spec.kind)
    if (t < 0) throw new FoldError(`unknown kind "${spec.kind}" (use one of ${TYPE_LABEL.join(', ')})`)
    candidates = found.filter((s) => s.type === t)
    if (candidates.length === 0) {
      const present = [...new Set(found.map((s) => TYPE_LABEL[s.type]))].join(', ')
      throw new FoldError(`no "${spec.kind}" state here; valid kinds: ${present}`)
    }
  } else {
    const best = Math.min(...found.map((s) => s.type))
    candidates = found.filter((s) => s.type === best)
  }
  candidates.sort((a, b) => (a.nRF - b.nRF) || (a.ord - b.ord))
  const sel = candidates[Math.min(spec.pick ?? 0, candidates.length - 1)]
  const edges = X.BF_GB_GA_GI_2_edges(BF, GB, GA, sel.gi)
  const FO = X.edges_Ff_2_FO(edges, Ff) as FaceOrder[]
  const [H, EAto] = COMP.FO_Ff_EF_2_H_EA(FO, Ff, EF)
  const layersFrom: number[] = FVy.map(() => 0)
  for (let f = 0; f < F_map2.length; ++f) {
    for (const f_ of F_map2[f]) layersFrom[f_] = st.layers[f]
  }
  const layers = linearize(H, Ff.length, layersFrom)
  if (layers === undefined) {
    throw new FoldError('chosen state has cyclic layering; try another kind/pick')
  }
  // hinge invariant: every vertex shared by a moving and a static face
  // must lie ON the fold line, else reflecting the flap stretches the
  // static paper (invalid, and invisible to the layer solver). Fail loudly.
  {
    const onMoving: boolean[] = Vx.map(() => false)
    const onStatic: boolean[] = Vx.map(() => false)
    FVy.forEach((F: number[], fi: number) => {
      for (const vi of F) {
        if (FM[fi]) onMoving[vi] = true
        else onStatic[vi] = true
      }
    })
    const [u, d] = line
    for (let vi = 0; vi < Vx.length; ++vi) {
      if (!onMoving[vi] || !onStatic[vi]) continue
      const off = Math.abs(Vx[vi][0] * u[0] + Vx[vi][1] * u[1] - d)
      if (off > 1e-6) {
        throw new FoldError(
          `the selected flap's hinge leaves the fold line by ${off.toFixed(3)} — ` +
          'the paper would stretch; move the line through the flap\'s corner ' +
          'or pick a different flap')
      }
    }
  }
  const dirs = flapDirs(FVy, Vx as Vec2[], FM, line, FO, layers)
  // dihedral targets: start angles from the carried orders (FOO) with the
  // movers' parity mirrored (they haven't reflected yet); end angles from
  // the solved orders. A valley ('V') is a NEGATIVE dihedral (empirical).
  const FfFrom = Ff.map((f: boolean, fi: number) => FM[fi] ? !f : f)
  const EAfrom = COMP.FO_Ff_EF_2_H_EA(FOO, FfFrom, EF)[1] as string[]
  const angleOf = (ea: string): number =>
    ea === 'V' ? -FLAT_ANGLE : ea === 'M' ? FLAT_ANGLE : 0
  return {
    state: { V: Vy, FV: FVy, FO, Ff, sheet: Sy as Vec2[], layers, eps: FOLDn.eps },
    anim: {
      Vfrom: Vx as Vec2[], moving: FM, line, layersFrom, dirs,
      EV: FOLDn.EV as [number, number][],
      angleFrom: EAfrom.map(angleOf),
      angleTo: (EAto as string[]).map(angleOf),
    },
    type: TYPE_LABEL[sel.type],
    nStates: Number(n),
  }
}

// One rotation sense per connected flap (faces sharing a vertex are one
// rigid body), voted from the solved stacking: a flap ending on top must
// swing toward +z, which for a face starting on side s means sense = s.
const flapDirs = (
  FV: number[][], Vfrom: Vec2[], moving: boolean[], line: Line,
  FO: FaceOrder[], layers: number[],
): number[] => {
  const [u, d] = line
  const n = FV.length
  const comp = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    while (comp[i] !== i) { comp[i] = comp[comp[i]]; i = comp[i] }
    return i
  }
  const byVertex = new Map<number, number>()
  for (let fi = 0; fi < n; ++fi) {
    if (!moving[fi]) continue
    for (const vi of FV[fi]) {
      const other = byVertex.get(vi)
      if (other === undefined) byVertex.set(vi, fi)
      else comp[find(fi)] = find(other)
    }
  }
  const side = (fi: number): number => {
    let sum = 0
    for (const vi of FV[fi]) sum += Vfrom[vi][0] * u[0] + Vfrom[vi][1] * u[1] - d
    return Math.sign(sum)
  }
  const votes = new Map<number, number>()
  for (const [f, g] of FO) {
    if (moving[f] === moving[g]) continue
    const mover = moving[f] ? f : g
    const still = moving[f] ? g : f
    const c = find(mover)
    votes.set(c, (votes.get(c) ?? 0) +
      Math.sign(layers[mover] - layers[still]) * side(mover))
  }
  return FV.map((_, fi) => {
    if (!moving[fi]) return 0
    const v = votes.get(find(fi)) ?? 0
    return v >= 0 ? 1 : -1
  })
}

// Positions of the animated fold at fraction t ∈ [0, 1]: moving flaps
// rotate about the fold line, out of plane, landing on the reflected
// position at t = 1. Returns [x, y, z] per vertex.
export const animatedPositions = (
  m: Pick<StepMotion, 'Vfrom' | 'line' | 'moving' | 'dirs' | 'FV'>, t: number,
): [number, number, number][] => {
  const { Vfrom, moving, line, dirs, FV } = m
  const [u, d] = line
  const theta = Math.PI * Math.min(1, Math.max(0, t))
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const sense: number[] = Vfrom.map(() => 0)
  for (let fi = 0; fi < FV.length; ++fi) {
    if (!moving[fi]) continue
    for (const vi of FV[fi]) sense[vi] = dirs[fi]
  }
  return Vfrom.map((p, vi) => {
    const h = M.dot(p, u) - d
    if (sense[vi] === 0 || Math.abs(h) < 1e-12) return [p[0], p[1], 0]
    const hh = h * cos
    return [p[0] + (hh - h) * u[0], p[1] + (hh - h) * u[1], sense[vi] * h * sin]
  })
}

// ── Fold table → render program ─────────────────────────────────────────────
// The fold table is the authoring surface: one row per fold (fold line in
// the unit-square world frame, sheet-space move markers, kind/pick, beat
// timing). Compiling runs the engine row by row and bakes everything a
// renderer needs into a plain-data program (centered/scaled for display).

export interface FoldTableRowSpec {
  name: string
  line: Line
  move: Vec2[]
  kind?: string
  pick?: number
  beat: number
  dur: number
  to: number   // terminal swing fraction: 1 = flat, 0.5 = held at 90°
  crease: boolean  // kind "crease": cut only, nothing folds, no timeline slot
}

export interface FoldProgramStep {
  name: string
  type: string
  t0: number
  t1: number
  to: number
  FV: number[][]
  Vfrom: Vec2[]      // display frame
  line: Line         // display frame
  moving: boolean[]
  layers: number[]      // stacking after this fold lands
  layersFrom: number[]  // stacking before it, on this step's face set
  dirs: number[]        // rotation sense per face (0 = static)
  // baked motion (reverse folds, sinks, …): keyframed vertex positions,
  // display frame, flattened [frame][vertex][xyz]; absent = rigid swing.
  // Mechanism bakes also carry zDirs, each face's layer-offset direction
  // per frame ([frame][face][xyz]) — the world ẑ carried by the face's
  // assembly so the display stack rides the paper instead of shearing.
  soft?: { frames: number; pos: number[]; zDirs?: number[] }
  // display parity before/after: a fold acting on the underside turns the
  // model over first (flipTo ≠ flipFrom, animated in the opening window)
  // so the working side always faces up
  flipFrom: number
  flipTo: number
}

export interface FoldTableProgram {
  kind: 'fold-table'
  size: number
  initial: { FV: number[][]; V: Vec2[] }
  steps: FoldProgramStep[]
  end: number        // beat when the last swing lands
  // display stacking: layer index * gap = z offset; one gap for the whole
  // program so the stack never jumps between steps
  gap: number
  maxLayer: number
  // paper direction displayed as the viewer's vertical: turn-overs rotate
  // about it so the model mirrors left-right instead of tumbling. Default [0,1].
  flipAxis?: Vec2
}

const KIND_ALIASES: Record<string, string> = {
  simple: 'Pureland', pureland: 'Pureland',
  reverse: 'Inside Reverse', inside: 'Inside Reverse',
  'inside reverse': 'Inside Reverse', outside: 'Outside Reverse',
  'outside reverse': 'Outside Reverse', 'mixed reverse': 'Mixed Reverse',
  'open sink': 'Open Sink', 'closed sink': 'Closed Sink',
  'mixed sink': 'Mixed Sink', sink: 'Open Sink', complex: 'Complex',
}

const parsePoint = (v: unknown, what: string, name: string): Vec2 => {
  const parts = String(v).split(',').map((s) => Number(s.trim()))
  if (parts.length !== 2 || parts.some((x) => !Number.isFinite(x))) {
    throw new FoldError(`step "${name}": ${what} must be "x,y", got ${JSON.stringify(v)}`)
  }
  return parts as Vec2
}

// Editable tables materialize every column, so unset cells arrive as ""
// or non-numbers — treat those as absent (Number("") is 0, which would
// silently zero a fold's timing).
const strAt = (r: Record<string, unknown>, key: string): string | undefined => {
  const v = r[key]
  if (v == null) return undefined
  const s = String(v).trim()
  return s === '' ? undefined : s
}
const numAt = (r: Record<string, unknown>, key: string): number | undefined => {
  const v = r[key]
  if (v == null || (typeof v === 'string' && v.trim() === '')) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
// number columns default to 0 in the table panel and 0 is meaningless for
// these, so non-positive means unset too
const posAt = (r: Record<string, unknown>, key: string): number | undefined => {
  const n = numAt(r, key)
  return n !== undefined && n > 0 ? n : undefined
}

const isCrease = (r: Record<string, unknown>): boolean =>
  (strAt(r, 'kind') ?? '').toLowerCase() === 'crease'

export const parseFoldRows = (rows: Record<string, unknown>[]): FoldTableRowSpec[] => {
  const specs: FoldTableRowSpec[] = []
  let foldCount = 0
  rows.forEach((r, i) => {
    if (r == null) return
    const name = strAt(r, 'step') ?? `fold${i + 1}`
    const p1raw = strAt(r, 'p1')
    const p2raw = strAt(r, 'p2')
    if (p1raw === undefined || p2raw === undefined) {
      throw new FoldError(`step "${name}": needs p1 and p2 ("x,y") for its fold line`)
    }
    const p1 = parsePoint(p1raw, 'p1', name)
    const p2 = parsePoint(p2raw, 'p2', name)
    const moveRaw = strAt(r, 'move')
    if (moveRaw === undefined && !isCrease(r)) {
      throw new FoldError(`step "${name}": needs move ("x,y" sheet points, ";"-separated)`)
    }
    const move = (moveRaw ?? '').split(';').filter((m) => m.trim() !== '')
      .map((m) => parsePoint(m, 'move', name))
    let kind: string | undefined
    let crease = false
    const kindRaw = strAt(r, 'kind')
    if (kindRaw !== undefined) {
      if (kindRaw.toLowerCase() === 'crease') {
        crease = true
      } else {
        kind = KINDS.includes(kindRaw) ? kindRaw : KIND_ALIASES[kindRaw.toLowerCase()]
        if (kind === undefined) {
          throw new FoldError(`step "${name}": unknown kind "${kindRaw}" (try simple, reverse, sink, crease, …)`)
        }
      }
    }
    if (!crease) foldCount += 1
    const beat = posAt(r, 'beat') ?? foldCount
    const dur = posAt(r, 'dur') ?? 0.75
    const to = Math.min(1, posAt(r, 'to') ?? 1)
    specs.push({
      name, line: lineThrough(p1, p2), move,
      kind, pick: numAt(r, 'pick'),
      beat, dur, to, crease,
    })
  })
  return specs
}

export const compileFoldTable = (
  rows: Record<string, unknown>[], opts: { size?: number } = {},
): FoldTableProgram => {
  const size = opts.size ?? 1
  const scale = 2 * size
  const toDisplay = (p: Vec2): Vec2 => [(p[0] - 0.5) * scale, (p[1] - 0.5) * scale]
  const lineToDisplay = ([u, d]: Line): Line => [u, (d - (u[0] + u[1]) * 0.5) * scale]
  const specs = parseFoldRows(rows)
  let st = initialState()
  const initial = { FV: st.FV.map((F) => [...F]), V: st.V.map(toDisplay) }
  const steps: FoldProgramStep[] = []
  const reverses: ReverseRecord[] = []
  const priorLines: Line[] = []
  let parity = 0
  for (const spec of specs) {
    if (spec.crease) {
      try {
        st = creaseStep(st, spec.line)
      } catch (e) {
        if (e instanceof FoldError) throw new FoldError(`step "${spec.name}": ${e.message}`)
        throw e
      }
      continue
    }
    let out: FoldOutcome
    try {
      out = foldStep(st, spec)
    } catch (e) {
      if (e instanceof FoldError) throw new FoldError(`step "${spec.name}": ${e.message}`)
      throw e
    }
    const soft = bakeMotion(out, spec, reverses, priorLines, scale, size, parity)
    // the paper lies on a table and the folder looks down: every swing must
    // rise toward the viewer. Measure the apex of the motion that will
    // actually play and turn the model over first when it would dip — the
    // parity while the fold plays mirrors z, so the sign picks it outright.
    // Mechanism steps never flip: their anchor is already probed (bakeMotion)
    // to open toward the viewer under the running parity.
    const stepMotion: StepMotion = {
      Vfrom: out.anim.Vfrom.map(toDisplay),
      line: lineToDisplay(out.anim.line),
      moving: out.anim.moving,
      dirs: out.anim.dirs,
      FV: out.state.FV,
      soft,
    }
    const apex = soft?.zDirs ? 0 : swingApex(stepMotion, spec.to)
    const flipTo = apex === 0 ? parity : apex > 0 ? 0 : 1
    steps.push({
      name: spec.name,
      type: out.type,
      t0: spec.beat,
      t1: spec.beat + spec.dur,
      to: spec.to,
      FV: out.state.FV.map((F) => [...F]),
      Vfrom: stepMotion.Vfrom,
      line: stepMotion.line,
      moving: out.anim.moving,
      layers: out.state.layers,
      layersFrom: out.anim.layersFrom,
      dirs: out.anim.dirs,
      soft,
      flipFrom: parity,
      flipTo,
    })
    parity = steps[steps.length - 1].flipTo
    const rec = reverseRecordOf(out)
    if (rec) reverses.push(rec)
    priorLines.push(spec.line)
    st = out.state
  }
  for (let i = 1; i < steps.length; ++i) {
    if (steps[i].t0 < steps[i - 1].t1 - 1e-9) {
      throw new FoldError(`step "${steps[i].name}": starts at beat ${steps[i].t0} before step "${steps[i - 1].name}" lands at ${steps[i - 1].t1} — folds happen one at a time`)
    }
  }
  for (let i = 0; i < steps.length - 1; ++i) {
    if (steps[i].to < 1) {
      throw new FoldError(`step "${steps[i].name}": only the last step may stop short of flat (to < 1)`)
    }
  }
  let maxLayer = 1
  for (const step of steps) {
    for (const l of step.layers) maxLayer = Math.max(maxLayer, l)
  }
  return {
    kind: 'fold-table', size, initial, steps,
    end: steps.length > 0 ? steps[steps.length - 1].t1 : 1,
    gap: (STACK_DEPTH * size) / maxLayer,
    maxLayer,
  }
}

// total stack thickness relative to paper size — each layer gets an equal
// slice, so deep models stay visually thin
const STACK_DEPTH = 0.05

const SOFT_FRAMES = 16
// mechanism bakes are closed-form and cheap, so afford dense keyframes:
// a fast 180° sweep lerped across few segments cuts inside the rotation
// arc and reads as jitter. Odd count puts a keyframe exactly at the apex.
const MECH_FRAMES = 49
const SOFT_MAX_FACES = 20

// Bake the relaxed in-between motion for one step: the mesh relaxes from
// the flat start (seeded a hair along each flap's rigid swing to break
// symmetry toward its landing side) while crease targets ramp to the end
// state's angles. Display frame, flattened [frame][vertex][xyz].
const bakeStep = (out: FoldOutcome, scale: number): { frames: number; pos: number[] } => {
  const { FV, sheet } = out.state
  const { Vfrom, moving, line, dirs, EV, angleFrom, angleTo } = out.anim
  const [EF] = X.EV_FV_2_EF_FE(EV, FV)
  // the pocket: only the pressed creases of static faces that overlap a
  // mover in the solved stack open to let the point through — the rest
  // stays pressed (a folder opens one pocket, not the whole bird)
  const pocket = FV.map(() => false)
  for (const [f, g] of out.state.FO) {
    if (moving[f] !== moving[g]) pocket[moving[f] ? g : f] = true
  }
  const flank = EV.map((_, ei) => {
    if (Math.abs(angleTo[ei] - angleFrom[ei]) > 1e-9) return false
    if (Math.abs(angleFrom[ei]) < 1e-9) return false
    return EF[ei].some((fi: number) => pocket[fi])
  })
  const mesh = buildSoftMesh(FV, sheet, EV, EF, angleFrom, angleTo,
    pickPinned(FV, sheet, moving), flank)
  const seed = new Float64Array(sheet.length * 3)
  const [u, d] = line
  const theta = Math.PI * 0.05
  const sense: number[] = sheet.map(() => 0)
  for (let fi = 0; fi < FV.length; ++fi) {
    if (!moving[fi]) continue
    for (const vi of FV[fi]) sense[vi] = dirs[fi]
  }
  Vfrom.forEach((p, vi) => {
    const h = p[0] * u[0] + p[1] * u[1] - d
    if (sense[vi] === 0 || Math.abs(h) < 1e-12) {
      seed[vi * 3] = p[0]; seed[vi * 3 + 1] = p[1]; seed[vi * 3 + 2] = 0
    } else {
      const hh = h * Math.cos(theta)
      seed[vi * 3] = p[0] + (hh - h) * u[0]
      seed[vi * 3 + 1] = p[1] + (hh - h) * u[1]
      seed[vi * 3 + 2] = sense[vi] * h * Math.sin(theta)
    }
  })
  const baked = bakeSoftMotion(mesh, seed, { frames: SOFT_FRAMES })
  const pos: number[] = []
  for (const frame of baked) {
    for (let vi = 0; vi < sheet.length; ++vi) {
      pos.push((frame[vi * 3] - 0.5) * scale, (frame[vi * 3 + 1] - 0.5) * scale, frame[vi * 3 + 2] * scale)
    }
  }
  return { frames: baked.length, pos }
}

// Bake the analytic reverse-fold mechanism for one step. Frames are exact
// rigid placements, so the endpoint blend in foldTablePositions is a
// no-op safety net.
const bakeMech = (
  out: FoldOutcome, reverses: ReverseRecord[], pageLines: Line[], scale: number,
  anchor: 'a' | 'b',
): { frames: number; pos: number[]; zDirs: number[] } | undefined => {
  const mech = buildReverseMech(out, reverses, pageLines)
  if (!mech) return undefined
  // on deep models, earlier reverse folds are finished features (a made
  // neck should stay a neck): cap the opening below the exact branch point
  // so they stay pressed, the small seam error bending across shared
  // vertices. Shallow collapses keep the exact full-open motion.
  const betaCap = mech.slavePairs > 0 && out.state.FV.length > SOFT_MAX_FACES
    ? MECH_BETA_CAP : undefined
  const baked = mech.frames(MECH_FRAMES, { anchor, betaCap })
  if (baked.pos.length < MECH_FRAMES) return undefined
  const nv = out.state.sheet.length
  const pos: number[] = []
  for (const frame of baked.pos) {
    for (let vi = 0; vi < nv; ++vi) {
      pos.push((frame[vi * 3] - 0.5) * scale, (frame[vi * 3 + 1] - 0.5) * scale, frame[vi * 3 + 2] * scale)
    }
  }
  return { frames: baked.pos.length, pos, zDirs: baked.zdir.flat() }
}

// Routing gates: a bake that drives paper through paper deeper than its
// budget is discarded for the next fallback. The relaxed solver gets a
// tight budget (failing plunges measure ~9 stack thicknesses); the
// mechanism's looser budget allows the bounded page-brush of uncreased
// paper spanning the opening spine (rigid assemblies cannot bend there).
const GATE_RELAX_DEPTH = 2 * STACK_DEPTH
const GATE_MECH_DEPTH = 4.5 * STACK_DEPTH
// collapse pockets legitimately stretch edges up to ~60% transiently;
// past this a relaxed bake is teleporting, not bowing
const GATE_RELAX_STRAIN = 0.65
// how far the book opens when earlier reverse folds ride along (~35°)
const MECH_BETA_CAP = 0.6
// fraction of a flipping step's swing spent turning the model over
const FLIP_WINDOW = 0.3

// One step's motion at fraction t (display frame, before layer offsets and
// parity). Shared by playback and the compile-time gates, so what is
// judged is exactly what is shown.
interface StepMotion {
  Vfrom: Vec2[]
  line: Line
  moving: boolean[]
  dirs: number[]
  FV: number[][]
  soft?: { frames: number; pos: number[]; zDirs?: number[] }
}

const sampleStepMotion = (m: StepMotion, t: number): {
  pos: [number, number, number][]
  zDir?: [number, number, number][]
  // per-face sign of the layer-offset target: an assembly ending the step
  // flipped needs the mirrored scalar so direction × scalar lands on the
  // next step's stacking
  sig?: number[]
} => {
  if (m.soft === undefined) return { pos: animatedPositions(m, t) }
  const start = animatedPositions(m, 0)
  const end = animatedPositions(m, 1)
  // sample the bake, easing residuals into the exact endpoint geometry
  const { frames, pos: P, zDirs } = m.soft
  const nv = m.Vfrom.length
  const x = t * (frames - 1)
  const f0 = Math.min(frames - 1, Math.floor(x))
  const f1 = Math.min(frames - 1, f0 + 1)
  const fx = x - f0
  const a = 1 - smooth(0, 0.15, t)
  const b = smooth(0.85, 1, t)
  const pos = m.Vfrom.map((_, vi): [number, number, number] => {
    const out: [number, number, number] = [0, 0, 0]
    for (let c = 0; c < 3; ++c) {
      const baked = P[(f0 * nv + vi) * 3 + c] * (1 - fx) + P[(f1 * nv + vi) * 3 + c] * fx
      out[c] = baked +
        a * (start[vi][c] - P[vi * 3 + c]) +
        b * (end[vi][c] - P[((frames - 1) * nv + vi) * 3 + c])
    }
    return out
  })
  let zDir: [number, number, number][] | undefined
  let sig: number[] | undefined
  if (zDirs) {
    const nf = m.FV.length
    zDir = m.FV.map((_, fi) => {
      const v: [number, number, number] = [0, 0, 0]
      for (let c = 0; c < 3; ++c) {
        v[c] = zDirs[(f0 * nf + fi) * 3 + c] * (1 - fx) + zDirs[(f1 * nf + fi) * 3 + c] * fx
      }
      const n = Math.hypot(v[0], v[1], v[2]) || 1
      return [v[0] / n, v[1] / n, v[2] / n]
    })
    sig = m.FV.map((_, fi) => (zDirs[((frames - 1) * nf + fi) * 3 + 2] < 0 ? -1 : 1))
  }
  return { pos, zDir, sig }
}

// worst edge stretch of a bake AS DISPLAYED — sampled through the playback
// path, so strain the endpoint blend masks doesn't count and strain it
// exposes does
const bakeStrain = (
  bake: { frames: number; pos: number[] }, out: FoldOutcome, scale: number,
): number => {
  const { FV } = out.state
  const [u, d] = out.anim.line
  const motion: StepMotion = {
    Vfrom: out.anim.Vfrom.map((p): Vec2 => [(p[0] - 0.5) * scale, (p[1] - 0.5) * scale]),
    line: [u, (d - (u[0] + u[1]) * 0.5) * scale],
    moving: out.anim.moving,
    dirs: out.anim.dirs,
    FV,
    soft: bake,
  }
  const seen = new Set<string>()
  const edges: [number, number, number][] = []
  for (const F of FV) {
    for (let i = 0, j = F.length - 1; i < F.length; j = i++) {
      const key = F[i] < F[j] ? `${F[i]}:${F[j]}` : `${F[j]}:${F[i]}`
      if (seen.has(key)) continue
      seen.add(key)
      const rest = Math.hypot(
        motion.Vfrom[F[i]][0] - motion.Vfrom[F[j]][0], motion.Vfrom[F[i]][1] - motion.Vfrom[F[j]][1])
      if (rest > 1e-9) edges.push([F[i], F[j], rest])
    }
  }
  let worst = 0
  const S = 24
  for (let i = 1; i < S; ++i) {
    const { pos } = sampleStepMotion(motion, i / S)
    for (const [a, b, rest] of edges) {
      const len = Math.hypot(pos[a][0] - pos[b][0], pos[a][1] - pos[b][1], pos[a][2] - pos[b][2])
      worst = Math.max(worst, Math.abs(len - rest) / rest)
    }
  }
  return worst
}
const bakePassesGate = (
  bake: { frames: number; pos: number[] } | undefined,
  FV: number[][], nv: number, size: number, budget: number,
): boolean => {
  if (!bake) return false
  const frames = [...Array(bake.frames).keys()].map((f) => ({
    pos: (vi: number): [number, number, number] => [
      bake.pos[(f * nv + vi) * 3], bake.pos[(f * nv + vi) * 3 + 1], bake.pos[(f * nv + vi) * 3 + 2]],
  }))
  return bakedMotionDepth(FV, frames) <= budget * size
}

// Signed apex of a step's swing in the engine frame: area-weighted height of
// the faces at the deepest point of the motion that will ACTUALLY play (rigid
// or baked), sampled through the same path playback uses. The display parity
// is chosen from this — the rigid fold direction can disagree with a baked
// relax or mechanism motion, and a vote from the wrong motion is exactly what
// made the paper flip over and then fold away from the viewer anyway.
const swingApex = (m: StepMotion, to: number): number => {
  const area = m.FV.map((F) => {
    let a = 0
    for (let i = 0, j = F.length - 1; i < F.length; j = i++) {
      a += m.Vfrom[F[j]][0] * m.Vfrom[F[i]][1] - m.Vfrom[F[i]][0] * m.Vfrom[F[j]][1]
    }
    return Math.abs(a / 2)
  })
  const base = sampleStepMotion(m, 0).pos
  let apex = 0
  for (const f of [0.25, 0.5, 0.75]) {
    const { pos } = sampleStepMotion(m, f * to)
    let s = 0
    for (let fi = 0; fi < m.FV.length; ++fi) {
      let dz = 0
      for (const vi of m.FV[fi]) dz += (pos[vi][2] - base[vi][2]) / m.FV[fi].length
      s += area[fi] * dz
    }
    if (Math.abs(s) > Math.abs(apex)) apex = s
  }
  return apex
}

// Motion routing for one step: rigid for simple and held folds; relaxed
// soft motion for shallow folds; the analytic mechanism for deep stacks or
// when relaxation fails its gate; rigid when nothing passes. On mechanism
// gate failure, earlier fold lines are freed one at a time (most recent
// first) so overhanging pages can fan out of the way.
const bakeMotion = (
  out: FoldOutcome, spec: FoldTableRowSpec, reverses: ReverseRecord[],
  priorLines: Line[], scale: number, size: number, parity: number,
): FoldProgramStep['soft'] => {
  if (out.type === 'Pureland' || spec.to < 1) return undefined
  const FV = out.state.FV
  const nv = out.state.sheet.length
  if (FV.length <= SOFT_MAX_FACES) {
    const relax = bakeStep(out, scale)
    const strain = bakeStrain(relax, out, scale)
    if (typeof process !== 'undefined' && process.env?.GATE_DEBUG) {
      console.log(`  [gate] relax strain=${(strain * 100).toFixed(1)}% depthOk=${bakePassesGate(relax, FV, nv, size, GATE_RELAX_DEPTH)}`)
    }
    if (bakePassesGate(relax, FV, nv, size, GATE_RELAX_DEPTH) &&
        strain <= GATE_RELAX_STRAIN) return relax
  }
  const recent = [...priorLines].reverse()
  // mechanism steps play under the running parity (they never flip — see
  // compileFoldTable), so try both anchors and keep the first whose book
  // measurably opens toward the viewer; a gate-passing bake that opens away
  // is only a last resort
  const motionOf = (soft: { frames: number; pos: number[]; zDirs: number[] }): StepMotion => ({
    Vfrom: out.anim.Vfrom.map((p): Vec2 => [(p[0] - 0.5) * scale, (p[1] - 0.5) * scale]),
    line: [out.anim.line[0], (out.anim.line[1] - (out.anim.line[0][0] + out.anim.line[0][1]) * 0.5) * scale],
    moving: out.anim.moving,
    dirs: out.anim.dirs,
    FV,
    soft,
  })
  let fallback: { frames: number; pos: number[]; zDirs: number[] } | undefined
  for (let nPages = 0; nPages <= recent.length; ++nPages) {
    for (const anchor of ['b', 'a'] as const) {
      const mech = bakeMech(out, reverses, recent.slice(0, nPages), scale, anchor)
      if (!bakePassesGate(mech, FV, nv, size, GATE_MECH_DEPTH)) continue
      if (swingApex(motionOf(mech!), 1) * (parity ? -1 : 1) > 0) return mech
      fallback ??= mech
    }
  }
  return fallback
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

// Fold-progress value → per-vertex [x, y, z] plus the face set to draw.
// fold = k + t means step k+1 is mid-swing at fraction t; whole numbers
// are the exact flat states. Every renderer consumes this one function.
export const foldTablePositions = (
  program: FoldTableProgram, fold: number,
): {
  FV: number[][]; pos: [number, number, number][]; moving: boolean[]
  zOff: number[]
  // layer-offset direction per face when the motion carries one (mechanism
  // bakes); undefined = world z, as in flat states
  zDir?: [number, number, number][]
} => {
  const N = program.steps.length
  const mid = program.maxLayer / 2
  if (N === 0 || fold <= 0) {
    return {
      FV: program.initial.FV,
      pos: program.initial.V.map((p) => [p[0], p[1], 0]),
      moving: program.initial.FV.map(() => false),
      zOff: program.initial.FV.map(() => program.gap * (0 - mid)),
    }
  }
  const k = Math.min(Math.floor(fold), N - 1)
  const tRaw = Math.min(1, Math.max(0, fold - k))
  const step = program.steps[k]
  // a flipping step turns the model over in its opening window, then the
  // fold plays in the remainder
  const flipping = step.flipTo !== step.flipFrom
  const t = flipping ? Math.max(0, (tRaw - FLIP_WINDOW) / (1 - FLIP_WINDOW)) : tRaw
  const flipT = flipping
    ? step.flipFrom + (step.flipTo - step.flipFrom) * smooth(0, FLIP_WINDOW, tRaw)
    : step.flipFrom
  const sampled = sampleStepMotion(
    { Vfrom: step.Vfrom, line: step.line, moving: step.moving, dirs: step.dirs, FV: step.FV, soft: step.soft }, t)
  let pos = sampled.pos
  let zDir = sampled.zDir
  const sig = sampled.sig
  // display heights ease from pre-fold to final stacking so steps join
  // without a jump. During a mechanism swing the offsets damp toward zero
  // mid-motion: the open book separates assemblies geometrically, and full
  // offsets along DIFFERENT assembly directions would shear the copies
  const damp = sampled.zDir ? 1 - 0.75 * Math.sin(Math.PI * t) : 1
  const zOff = step.FV.map((_, fi) => {
    const from = step.layersFrom[fi] - mid
    const target = (sig?.[fi] ?? 1) * (step.layers[fi] - mid)
    return program.gap * (from + (target - from) * t) * damp
  })
  // display parity: turn the model over in place about the in-plane axis
  // that displays as the viewer's vertical (mirrors left-right on screen).
  // Exact half-turns stay exactly flat (no trig residue): x' = 2(â·x)â − x.
  if (flipT !== 0) {
    const [ax, ay] = program.flipAxis ?? [0, 1]
    const rot = flipT === 1
      ? ([x, y, z]: [number, number, number]): [number, number, number] => {
          const dd = ax * x + ay * y
          return [2 * dd * ax - x, 2 * dd * ay - y, -z]
        }
      : ([x, y, z]: [number, number, number]): [number, number, number] => {
          // Rodrigues about â = (ax, ay, 0) by π·flipT
          const c = Math.cos(Math.PI * flipT)
          const s = Math.sin(Math.PI * flipT)
          const dd = (ax * x + ay * y) * (1 - c)
          return [
            x * c + ay * z * s + ax * dd,
            y * c - ax * z * s + ay * dd,
            (ax * y - ay * x) * s + z * c,
          ]
        }
    pos = pos.map(rot)
    zDir = (zDir ?? step.FV.map((): [number, number, number] => [0, 0, 1])).map(rot)
  }
  return { FV: step.FV, pos, moving: step.moving, zOff, zDir }
}

// The fold value a beat-timed schedule reaches at a given beat — steps swing
// during [t0, t1] and hold in between.
export const foldValueAt = (program: FoldTableProgram, beat: number): number => {
  let v = 0
  for (let i = 0; i < program.steps.length; ++i) {
    const { t0, t1, to } = program.steps[i]
    if (beat <= t0) break
    v = i + to * Math.min(1, (beat - t0) / (t1 - t0))
  }
  return v
}
