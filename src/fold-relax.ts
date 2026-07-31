// Soft in-betweens in the mould of Origami Simulator (Ghassaei/Demaine/
// Gershenfeld, 7OSME 2018): axial springs along triangulated edges plus
// angular springs driving crease dihedrals toward ramped targets, damped
// explicit integration. The exact flat states from fold-engine stay the
// ground truth; this only fills the motion between two consecutive states.
// Deterministic, compile-time only (baking) — no physics during playback.

export type Vec2 = [number, number]

export interface SoftEdge { a: number; b: number; L0: number; k: number }
export interface SoftHinge {
  a: number; b: number       // hinge edge
  c: number; d: number       // opposite vertices (face 1, face 2)
  k: number
  from: number               // dihedral target at t=0
  to: number                 // dihedral target at t=1
  // 'flank': a pressed crease bordering the action — transiently opens
  // mid-swing (the pocket) and presses shut again
  role: 'normal' | 'flank'
}

export interface SoftMesh {
  n: number                  // vertex count
  edges: SoftEdge[]
  hinges: SoftHinge[]
  pinned: boolean[]
  dt: number
}

const AXIAL_K = 60           // per unit rest length (stiff paper: strain reads as bend, not stretch)
const CREASE_K = 3           // base angular stiffness, per unit hinge length
// paper bends AT creases: a crease being worked is soft, a pressed fold
// holds hard, never-creased paper resists in between
const K_CHANGING = 1
const K_PRESSED = 2
const K_UNCREASED = 1
const MIN_L0 = 0.02          // sliver edges get stiffness as if this long
const MAX_STEP = 0.02        // per-iteration displacement clamp

// Just short of ±π: exactly-flat hinges are degenerate (the normal flips),
// and the endpoints are blended into the exact states anyway.
export const FLAT_ANGLE = Math.PI * 0.995

export const buildSoftMesh = (
  FV: number[][],            // faces over shared vertex indices
  sheet: Vec2[],             // material (rest) coordinates per vertex
  EV: [number, number][],    // edges of the face graph
  EF: number[][],            // faces per edge
  angleFrom: number[],       // target dihedral per EV edge at t=0
  angleTo: number[],         // per EV edge at t=1
  pinned: boolean[],
  flank?: boolean[],         // per EV edge: pressed crease that should open
): SoftMesh => {
  const n = sheet.length
  const edges: SoftEdge[] = []
  const hinges: SoftHinge[] = []
  const seen = new Set<string>()
  const restLen = (a: number, b: number): number =>
    Math.hypot(sheet[a][0] - sheet[b][0], sheet[a][1] - sheet[b][1])
  const addAxial = (a: number, b: number): void => {
    const key = a < b ? `${a},${b}` : `${b},${a}`
    if (seen.has(key)) return
    seen.add(key)
    const L0 = restLen(a, b)
    edges.push({ a, b, L0, k: AXIAL_K / Math.max(L0, MIN_L0) })
  }
  // triangulate each face as a fan in MATERIAL orientation (CCW in sheet
  // space) so every hinge's sign convention is the paper's own front side
  const fanOf = (F: number[]): number[] => {
    let area = 0
    for (let i = 0, j = F.length - 1; i < F.length; j = i++) {
      area += (sheet[F[j]][0] - sheet[F[i]][0]) * (sheet[F[j]][1] + sheet[F[i]][1])
    }
    return area > 0 ? F : [...F].reverse()
  }
  // third vertex of the fan triangle within `face` containing edge a-b —
  // hangs the hinge on real geometry
  const oppositeIn = (face: number[], a: number, b: number): number => {
    const F = fanOf(face)
    for (let j = 1; j + 1 < F.length; ++j) {
      const tri = [F[0], F[j], F[j + 1]]
      if (tri.includes(a) && tri.includes(b)) {
        return tri.find((v) => v !== a && v !== b)!
      }
    }
    throw new Error('edge not on face')
  }
  for (const face of FV) {
    const F = fanOf(face)
    for (let i = 0, j = F.length - 1; i < F.length; j = i++) addAxial(F[j], F[i])
    for (let j = 2; j + 1 < F.length; ++j) addAxial(F[0], F[j])
    // facet hinges across the fan diagonals keep faces stiff but bendable
    for (let j = 2; j + 1 < F.length; ++j) {
      hinges.push({
        a: F[0], b: F[j], c: F[j - 1], d: F[j + 1],
        k: CREASE_K * K_UNCREASED * restLen(F[0], F[j]), from: 0, to: 0,
        role: 'normal',
      })
    }
  }
  EV.forEach(([a, b], ei) => {
    const faces = EF[ei]
    if (faces.length !== 2) return
    // pick c from the face whose sheet-CCW loop traverses a->b, d from
    // the other — this fixes the dihedral's sign
    let f1 = faces[0]
    let f2 = faces[1]
    const traversesAB = (face: number[]): boolean => {
      const F = fanOf(face)
      for (let i = 0, j = F.length - 1; i < F.length; j = i++) {
        if (F[j] === a && F[i] === b) return true
      }
      return false
    }
    if (!traversesAB(FV[f1])) { const t = f1; f1 = f2; f2 = t }
    const changing = Math.abs(angleTo[ei] - angleFrom[ei]) > 1e-9
    const pressed = !changing && Math.abs(angleFrom[ei]) > 1e-9
    const weight = changing ? K_CHANGING : pressed ? K_PRESSED : K_UNCREASED
    hinges.push({
      a, b,
      c: oppositeIn(FV[f1], a, b),
      d: oppositeIn(FV[f2], a, b),
      k: CREASE_K * weight * restLen(a, b),
      from: angleFrom[ei],
      to: angleTo[ei],
      role: (pressed && flank !== undefined && flank[ei]) ? 'flank' : 'normal',
    })
  })
  // explicit-integration stability: dt bounded by the stiffest spring —
  // hinges act on their flap vertices with k/h² leverage at rest geometry
  let kMax = 1
  for (const e of edges) kMax = Math.max(kMax, e.k)
  for (const h of hinges) {
    const hc = triHeight(sheet, h.a, h.b, h.c)
    const hd = triHeight(sheet, h.a, h.b, h.d)
    kMax = Math.max(kMax, h.k / Math.max(Math.min(hc, hd), MIN_L0) ** 2)
  }
  const dt = 0.5 / Math.sqrt(kMax)
  return { n, edges, hinges, pinned, dt }
}

const triHeight = (sheet: Vec2[], a: number, b: number, c: number): number => {
  const ex = sheet[b][0] - sheet[a][0]
  const ey = sheet[b][1] - sheet[a][1]
  const cx = sheet[c][0] - sheet[a][0]
  const cy = sheet[c][1] - sheet[a][1]
  const e = Math.hypot(ex, ey)
  return e < 1e-12 ? 0 : Math.abs(ex * cy - ey * cx) / e
}

const sub = (o: Float64Array, i: number, j: number): [number, number, number] =>
  [o[i * 3] - o[j * 3], o[i * 3 + 1] - o[j * 3 + 1], o[i * 3 + 2] - o[j * 3 + 2]]
const cross = (a: number[], b: number[]): [number, number, number] =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a: number[]): number => Math.hypot(a[0], a[1], a[2])

// One relaxation pass toward the given per-hinge targets. Returns the
// largest vertex move, so callers can iterate to quiescence.
export const relax = (
  mesh: SoftMesh, pos: Float64Array, vel: Float64Array,
  target: (h: SoftHinge) => number, iterations: number,
): number => {
  const F = new Float64Array(mesh.n * 3)
  let maxMove = 0
  let lastKE = Infinity
  for (let it = 0; it < iterations; ++it) {
    F.fill(0)
    for (const e of mesh.edges) {
      const d = sub(pos, e.b, e.a)
      const L = len(d)
      if (L < 1e-12) continue
      const f = e.k * (L - e.L0) / L
      for (let c = 0; c < 3; ++c) {
        F[e.a * 3 + c] += f * d[c]
        F[e.b * 3 + c] -= f * d[c]
      }
    }
    for (const h of mesh.hinges) {
      const e = sub(pos, h.b, h.a)
      const eLen = len(e)
      if (eLen < 1e-12) continue
      const eHat = [e[0] / eLen, e[1] / eLen, e[2] / eLen]
      const ra = sub(pos, h.c, h.a)
      const rb = sub(pos, h.d, h.a)
      const n1 = cross(e, ra)      // normal of (a, b, c) — material front
      const n2 = cross(rb, e)      // normal of (a, d, b)
      const l1 = len(n1)
      const l2 = len(n2)
      if (l1 < 1e-12 || l2 < 1e-12) continue
      const theta = Math.atan2(dot(cross(n1, n2), eHat), dot(n1, n2))
      // ∂θ/∂x_c points along −n̂1 (verified numerically)
      const m = h.k * (theta - target(h))
      // torque lever is 1/height — floor it so a transiently degenerate
      // triangle can't kick the mesh into orbit
      const h1 = Math.max(l1 / eLen, MIN_L0)
      const h2 = Math.max(l2 / eLen, MIN_L0)
      const fc = m / h1
      const fd = m / h2
      const t3 = dot(ra, eHat) / eLen
      const t4 = dot(rb, eHat) / eLen
      for (let c = 0; c < 3; ++c) {
        const n1c = n1[c] / l1
        const n2c = n2[c] / l2
        F[h.c * 3 + c] += fc * n1c
        F[h.d * 3 + c] += fd * n2c
        F[h.a * 3 + c] -= (1 - t3) * fc * n1c + (1 - t4) * fd * n2c
        F[h.b * 3 + c] -= t3 * fc * n1c + t4 * fd * n2c
      }
    }
    // kinetic damping: the moment kinetic energy falls, the system passed
    // an energy minimum — stop dead and coast in from rest again. Robust
    // and fast for form-finding relaxation.
    maxMove = 0
    let ke = 0
    for (let i = 0; i < mesh.n; ++i) {
      if (mesh.pinned[i]) continue
      for (let c = 0; c < 3; ++c) {
        const j = i * 3 + c
        vel[j] += F[j] * mesh.dt
        // hard safety against transient force spikes
        const move = Math.max(-MAX_STEP, Math.min(MAX_STEP, vel[j] * mesh.dt))
        ke += vel[j] * vel[j]
        pos[j] += move
        maxMove = Math.max(maxMove, Math.abs(move))
      }
    }
    if (ke < lastKE) vel.fill(0)
    lastKE = ke
    if (maxMove < 1e-7) break
  }
  return maxMove
}

export interface BakeOptions {
  frames?: number            // baked keyframes across the swing (default 24)
  time?: number              // simulated relaxation time per keyframe
}

// Bake the motion between states: crease targets ramp linearly, each
// keyframe relaxes from the previous. `seedPos` is normally the rigid
// swing at small t, so every flap breaks symmetry toward its correct side.
export const bakeSoftMotion = (
  mesh: SoftMesh, seedPos: Float64Array, opts: BakeOptions = {},
): Float64Array[] => {
  const frames = opts.frames ?? 24
  // a TIME budget: stiffer meshes get smaller dt, so a fixed iteration
  // count would silently under-converge them
  const iterations = Math.min(6000, Math.ceil((opts.time ?? 10) / mesh.dt))
  const pos = Float64Array.from(seedPos)
  const vel = new Float64Array(mesh.n * 3)
  const out: Float64Array[] = []
  // pocket flanks open transiently and press shut — sin(πs) shapes it
  const FLANK_OPEN = Math.PI * 0.45
  // frame 0 is the seed itself: relaxing toward the from-state first can
  // lurch to a different flat configuration and snap back a frame later
  out.push(Float64Array.from(pos))
  for (let f = 1; f <= frames; ++f) {
    const s = f / frames
    relax(mesh, pos, vel, (h) => {
      if (h.role === 'flank') {
        const open = Math.sin(Math.PI * s) * FLANK_OPEN
        return h.from > 0 ? h.from - open : h.from + open
      }
      return h.from + (h.to - h.from) * s
    }, iterations)
    out.push(Float64Array.from(pos))
  }
  return out
}

// Unsigned polygon area by the shoelace formula.
export const polyArea = (F: number[], V: Vec2[]): number => {
  let a = 0
  for (let i = 0, j = F.length - 1; i < F.length; j = i++) {
    a += V[F[j]][0] * V[F[i]][1] - V[F[i]][0] * V[F[j]][1]
  }
  return Math.abs(a / 2)
}

// Pin the largest static face: it anchors position and orientation while
// everything that must flex stays free.
export const pickPinned = (
  FV: number[][], sheet: Vec2[], moving: boolean[],
): boolean[] => {
  let pinFace = -1
  for (let fi = 0; fi < FV.length; ++fi) {
    if (!moving[fi] && (pinFace < 0 || polyArea(FV[fi], sheet) > polyArea(FV[pinFace], sheet))) pinFace = fi
  }
  const pinned = sheet.map(() => false)
  if (pinFace >= 0) for (const vi of FV[pinFace]) pinned[vi] = true
  return pinned
}
