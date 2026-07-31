// Analytic motion for reverse folds through deep layer stacks (where the
// relaxation solver reads as crumpling): a symmetric reverse fold is a
// 1-DOF rigid mechanism. The model is cut into rigid assemblies at the
// moving creases; assemblies come in mirror pairs — the flanks open ±β
// about the spine, every other pair hangs off its parents by a hinge and
// closes the loop with one angle φ, solved from "the pair's seam stays in
// the mirror plane". No tuning: the opening angle is the branch point.
import type { FoldAnim, FoldOutcome, Line, Vec2 } from './fold-engine.js'
import { polyArea } from './fold-relax.js'
import { X } from './vendor/flatfolder/conversion.js'

// what a finished reverse fold leaves behind: the hinge it swung about,
// the seam its point now sits on (pre-fold seam reflected across the
// hinge), and the spine it opened around
export interface ReverseRecord { hinge: Line; seam: Line; spine: Line }

type V3 = [number, number, number]
type Xform = (x: V3) => V3

const FLAT = Math.PI * 0.9
const LINE_TOL = 1e-6

const lineDist = (l: Line, p: Vec2): number =>
  Math.abs(l[0][0] * p[0] + l[0][1] * p[1] - l[1])

const onLine = (l: Line, a: Vec2, b: Vec2): boolean =>
  lineDist(l, a) < LINE_TOL && lineDist(l, b) < LINE_TOL

// rotation about the z=0-plane line [u,d] (u = unit normal, dot(u,x)=d)
const rotLine = (l: Line, theta: number): Xform => {
  const [u, d] = l
  const px = u[0] * d
  const py = u[1] * d
  const ax = -u[1]
  const ay = u[0]
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  return (x: V3): V3 => {
    const rx = x[0] - px
    const ry = x[1] - py
    const rz = x[2]
    const ar = ax * rx + ay * ry
    return [
      px + c * rx + s * (-ay * rz) + (1 - c) * ar * ax,
      py + c * ry + s * (ax * rz) + (1 - c) * ar * ay,
      c * rz + s * (ay * rx - ax * ry),
    ]
  }
}

// the world line through the step's flipping creases (the point's seam)
const fitSeam = (anim: FoldAnim): Line | undefined => {
  const { EV, angleFrom, angleTo, Vfrom } = anim
  const pts: Vec2[] = []
  EV.forEach((e, ei) => {
    if (Math.abs(angleTo[ei] - angleFrom[ei]) <= 1e-9) return
    if (Math.abs(angleFrom[ei]) <= FLAT || Math.abs(angleTo[ei]) <= FLAT) return
    if (Math.sign(angleFrom[ei]) === Math.sign(angleTo[ei])) return
    pts.push(Vfrom[e[0]], Vfrom[e[1]])
  })
  if (pts.length < 2) return undefined
  let best: [Vec2, Vec2] | undefined
  let bestD = 1e-9
  for (const a of pts) for (const b of pts) {
    const d = Math.hypot(a[0] - b[0], a[1] - b[1])
    if (d > bestD) { bestD = d; best = [a, b] }
  }
  if (!best) return undefined
  const dir: Vec2 = [(best[1][0] - best[0][0]) / bestD, (best[1][1] - best[0][1]) / bestD]
  const seam: Line = [[-dir[1], dir[0]], -dir[1] * best[0][0] + dir[0] * best[0][1]]
  if (pts.some((p) => lineDist(seam, p) > LINE_TOL)) return undefined
  return seam
}

export const reverseRecordOf = (out: FoldOutcome): ReverseRecord | undefined => {
  const spine = fitSeam(out.anim)
  if (!spine) return undefined
  const hinge = out.anim.line
  const [u, d] = hinge
  const mirror = (p: Vec2): Vec2 => {
    const h = u[0] * p[0] + u[1] * p[1] - d
    return [p[0] - 2 * h * u[0], p[1] - 2 * h * u[1]]
  }
  const dir: Vec2 = [-spine[0][1], spine[0][0]]
  const p0: Vec2 = [spine[0][0] * spine[1], spine[0][1] * spine[1]]
  const a = mirror(p0)
  const b = mirror([p0[0] + dir[0], p0[1] + dir[1]])
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  const rdir: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len]
  const seam: Line = [[-rdir[1], rdir[0]], -rdir[1] * a[0] + rdir[0] * a[1]]
  return { hinge, seam, spine }
}

interface Pair {
  a: number               // component on the + side
  b: number               // component on the - side
  parent?: Pair           // undefined for the root flanks
  hinge?: Line            // line the pair swings about, in its parents' frame
  q?: Vec2                // seam endpoint farthest from the hinge
  active: boolean         // the point this step folds
  phi: number             // current hinge angle (+ side; - side gets -phi)
}

export interface MechFrameOpts {
  // fix this cover of the root pair flat for the whole motion (folding on
  // a table); default keeps the mirror plane fixed, both covers swing ±β
  anchor?: 'a' | 'b'
  // cap the book opening below the exact branch point: keeps earlier folds
  // pressed at the cost of a bounded seam error on the active point,
  // absorbed as bending by the shared-vertex averaging. Endpoints exact.
  betaCap?: number
}

export interface ReverseMech {
  // per frame: vertex positions (world [x,y,z]*V) and each face's layer-
  // offset direction ([x,y,z]*F) — the world ẑ carried by the face's
  // assembly, so display stacking rides the paper
  frames: (n: number, opts?: MechFrameOpts) => { pos: number[][]; zdir: number[][] }
  betaStar: number
  // pairs beyond the covers and the active point — earlier reverse folds
  // that must un-press while the book opens (the cue to cap the opening)
  slavePairs: number
}

const sameLine = (p: Line, q: Line): boolean =>
  (Math.abs(p[0][0] - q[0][0]) < LINE_TOL && Math.abs(p[0][1] - q[0][1]) < LINE_TOL && Math.abs(p[1] - q[1]) < LINE_TOL) ||
  (Math.abs(p[0][0] + q[0][0]) < LINE_TOL && Math.abs(p[0][1] + q[0][1]) < LINE_TOL && Math.abs(p[1] + q[1]) < LINE_TOL)

// pageLines: earlier fold lines whose pressed creases may be cut to free
// "pages" — one-sided assemblies that would otherwise overhang the opening
// spine and sweep through the opposite cover. A freed page fans at half
// the book angle. The caller escalates pageLines until the bake passes
// its clearance gate.
export const buildReverseMech = (
  out: FoldOutcome, history: ReverseRecord[], pageLines: Line[] = [],
): ReverseMech | undefined => {
  const { FV, sheet } = out.state
  const { EV, angleFrom, angleTo, Vfrom, moving, layersFrom, line } = out.anim
  const seamNow = fitSeam(out.anim)
  if (!seamNow) return undefined
  const [EF] = X.EV_FV_2_EF_FE(EV, FV)

  const changed = EV.map((_, ei) => Math.abs(angleTo[ei] - angleFrom[ei]) > 1e-9)
  const pressed = EV.map((_, ei) => !changed[ei] && Math.abs(angleFrom[ei]) > FLAT)

  // seam-type lines keep mirror pairs apart; hinge-type lines are swung
  // about; page-type lines free one-sided assemblies. Older reverse folds
  // join the escalation only when the model stays welded without them.
  interface CutLine { line: Line; kind: 'seam' | 'hinge' | 'page' }
  const addLine = (list: CutLine[], cand: CutLine): void => {
    if (!list.some((c) => sameLine(c.line, cand.line))) list.push(cand)
  }
  const cuts: CutLine[] = []
  addLine(cuts, { line: seamNow, kind: 'seam' })
  addLine(cuts, { line, kind: 'hinge' })
  const escalation = [...history].reverse()

  const area = (F: number[]): number => polyArea(F, sheet)

  const dbg = typeof process !== 'undefined' && process.env?.MECH_DEBUG
    ? (msg: string): void => { console.log(`  [mech] ${msg}`) }
    : undefined

  const attempt = (): ReverseMech | undefined => {
    // page-line cuts only apply between two static faces — a moving
    // point's plies stay welded to their slab
    const cutEdge = EV.map((e, ei) => {
      if (changed[ei]) return true
      if (!pressed[ei]) return false
      const cl = cuts.find((c) => onLine(c.line, Vfrom[e[0]], Vfrom[e[1]]))
      if (!cl) return false
      if (cl.kind !== 'page') return true
      const fs = EF[ei]
      return fs.length === 2 && !moving[fs[0]] && !moving[fs[1]]
    })

    const parent = FV.map((_, fi) => fi)
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])))
    const join = (a: number, b: number): void => {
      const [ra, rb] = [find(a), find(b)]
      if (ra !== rb) parent[ra] = rb
    }
    EV.forEach((_, ei) => {
      if (cutEdge[ei]) return
      const fs = EF[ei]
      if (fs.length === 2) join(fs[0], fs[1])
    })

    // plies that share a pressed seam AND hang off one common neighbour by
    // creases on one common line cannot move apart — weld them (a point's
    // plies on one side of the paper move as a slab)
    for (let pass = 0; pass < FV.length; ++pass) {
      const links = new Map<string, { a: number; b: number; lines: Line[]; anyPressed: boolean }>()
      EV.forEach((e, ei) => {
        if (!cutEdge[ei]) return
        const fs = EF[ei]
        if (fs.length !== 2) return
        const [ca, cb] = [find(fs[0]), find(fs[1])]
        if (ca === cb) return
        const key = ca < cb ? `${ca}:${cb}` : `${cb}:${ca}`
        let rec = links.get(key)
        if (!rec) { rec = { a: Math.min(ca, cb), b: Math.max(ca, cb), lines: [], anyPressed: false }; links.set(key, rec) }
        const cl = cuts.find((c) => onLine(c.line, Vfrom[e[0]], Vfrom[e[1]]))
        if (cl && !rec.lines.some((l) => sameLine(l, cl.line))) rec.lines.push(cl.line)
        if (pressed[ei]) rec.anyPressed = true
      })
      let welded = false
      for (const rec of links.values()) {
        if (!rec.anyPressed) continue
        // common neighbour on a common line?
        for (const other of links.values()) {
          if (other === rec) continue
          const third = other.a === rec.a || other.a === rec.b ? other.b
            : other.b === rec.a || other.b === rec.b ? other.a : -1
          if (third < 0) continue
          const mate = links.get(third < rec.a ? `${third}:${rec.a}` : `${rec.a}:${third}`)
          const mateB = links.get(third < rec.b ? `${third}:${rec.b}` : `${rec.b}:${third}`)
          if (!mate || !mateB) continue
          if (mate.lines.some((l) => mateB.lines.some((m) => sameLine(l, m)))) {
            join(rec.a, rec.b)
            welded = true
            break
          }
        }
        if (welded) break
      }
      if (!welded) break
    }

    const roots = new Map<number, number>()
    const compOf = FV.map((_, fi) => {
      const r = find(fi)
      if (!roots.has(r)) roots.set(r, roots.size)
      return roots.get(r)!
    })
    const nComp = roots.size
    dbg?.(`cuts=${cuts.length} nComp=${nComp}`)
    if (dbg) {
      const stats = Array.from({ length: nComp }, () => ({ faces: 0, moving: 0 }))
      FV.forEach((_, fi) => { stats[compOf[fi]].faces++; if (moving[fi]) stats[compOf[fi]].moving++ })
      dbg(`  comps: ${stats.map((s, i) => `${i}:${s.faces}f${s.moving ? '/mv' + s.moving : ''}`).join(' ')}`)
      dbg(`  cutLines: ${cuts.map((c) => `${c.kind}[${c.line[0].map((x) => x.toFixed(3))};${c.line[1].toFixed(3)}]`).join(' ')}`)
    }
    if (nComp < 4) return undefined

    const compArea = Array.from({ length: nComp }, () => 0)
    const compLayer = Array.from({ length: nComp }, () => 0)
    const compMoving = Array.from({ length: nComp }, () => false)
    FV.forEach((F, fi) => {
      const c = compOf[fi]
      const a = area(F)
      compArea[c] += a
      compLayer[c] += layersFrom[fi] * a
      if (moving[fi]) compMoving[c] = true
    })

    // comp-graph edges grouped by the cut line they lie on
    interface CEdge { a: number; b: number; line: Line; kind: 'seam' | 'hinge' | 'page'; flip: boolean }
    const cedges: CEdge[] = []
    EV.forEach((e, ei) => {
      if (!cutEdge[ei]) return
      const fs = EF[ei]
      if (fs.length !== 2) return
      const [ca, cb] = [compOf[fs[0]], compOf[fs[1]]]
      if (ca === cb) return
      const cl = cuts.find((c) => onLine(c.line, Vfrom[e[0]], Vfrom[e[1]]))
      if (!cl) return
      const isFlip = changed[ei] && Math.abs(angleFrom[ei]) > FLAT && Math.abs(angleTo[ei]) > FLAT
      if (!cedges.some((x) => ((x.a === ca && x.b === cb) || (x.a === cb && x.b === ca)) && sameLine(x.line, cl.line))) {
        cedges.push({ a: ca, b: cb, line: cl.line, kind: cl.kind, flip: isFlip })
      }
    })

    // mirror pairs join across seam-type lines; hinges across hinge-type
    const seamOf = Array.from({ length: nComp }, () => -1)
    const seamLine: (Line | undefined)[] = Array.from({ length: nComp }, () => undefined)
    for (const e of cedges) {
      if (e.kind !== 'seam') continue
      if ((seamOf[e.a] !== -1 && seamOf[e.a] !== e.b) || (seamOf[e.b] !== -1 && seamOf[e.b] !== e.a)) return undefined
      seamOf[e.a] = e.b
      seamOf[e.b] = e.a
      seamLine[e.a] = e.line
      seamLine[e.b] = e.line
    }
    // pages: one-sided static assemblies freed by a page-line cut — every
    // cut connection is a pressed crease on one page line to one parent
    interface Page { comp: number; parent: number; line: Line }
    const pages: Page[] = []
    for (let c = 0; c < nComp; ++c) {
      if (seamOf[c] !== -1 || compMoving[c]) continue
      const own = cedges.filter((e) => e.a === c || e.b === c)
      if (own.length === 0 || !own.every((e) => e.kind === 'page' && sameLine(e.line, own[0].line))) continue
      const parents = new Set(own.map((e) => (e.a === c ? e.b : e.a)))
      if (parents.size !== 1) continue
      pages.push({ comp: c, parent: [...parents][0], line: own[0].line })
    }
    const isPage = Array.from({ length: nComp }, () => false)
    for (const p of pages) isPage[p.comp] = true
    // a page's parent must not itself be a page, and nothing else may hang
    // off a page
    for (const p of pages) {
      if (isPage[p.parent]) return undefined
    }
    for (const e of cedges) {
      if (e.kind === 'page') continue
      if (isPage[e.a] || isPage[e.b]) return undefined
    }

    // comps with no seam creases of their own: allowed only as the two
    // book covers, coupling through the spine stretch an earlier fold's
    // point claimed
    const unpaired = [...Array(nComp).keys()].filter((c) => seamOf[c] === -1 && !isPage[c])
    if (unpaired.length !== 0 && unpaired.length !== 2) {
      dbg?.(`unpaired comps: seamOf=${JSON.stringify(seamOf)} pages=${pages.length} edges=${JSON.stringify(cedges.map((e) => `${e.a}-${e.b}:${e.kind}${e.flip ? '!' : ''}`))}`)
      return undefined
    }
    let seamlessRoot: number = -1
    if (unpaired.length === 2) {
      const [a, b] = unpaired
      if (compMoving[a] || compMoving[b]) return undefined
      seamOf[a] = b
      seamOf[b] = a
      seamlessRoot = a
    }

    // one pair per seam link; hinge edges connect pairs (mirror-matched:
    // a crease and its reflection must join the same two pairs on one line)
    const pairId = Array.from({ length: nComp }, () => -1)
    const pairComps: [number, number][] = []
    for (let c = 0; c < nComp; ++c) {
      if (pairId[c] !== -1 || isPage[c]) continue
      pairId[c] = pairComps.length
      pairId[seamOf[c]] = pairComps.length
      pairComps.push([c, seamOf[c]])
    }
    interface PLink { pi: number; pj: number; line: Line; sides: [number, number] }
    const plinks: PLink[] = []
    for (const e of cedges) {
      if (e.kind !== 'hinge') continue
      const [pi, pj] = [pairId[e.a], pairId[e.b]]
      if (pi === pj) { dbg?.(`hinge inside pair ${pi}`); return undefined }
      const mate = cedges.find((x) => x.kind === 'hinge' && sameLine(x.line, e.line) &&
        ((x.a === seamOf[e.a] && x.b === seamOf[e.b]) || (x.b === seamOf[e.a] && x.a === seamOf[e.b])))
      if (!mate) { dbg?.(`hinge ${e.a}-${e.b} has no mirror mate`); return undefined }
      if (!plinks.some((l) => ((l.pi === pi && l.pj === pj) || (l.pi === pj && l.pj === pi)) && sameLine(l.line, e.line))) {
        plinks.push({ pi, pj, line: e.line, sides: [e.a, e.b] })
      }
    }

    // the active pair holds every moving face; the root is its parent —
    // open exactly the pocket the point passes through
    const activeId = pairComps.findIndex(([a, b]) => compMoving[a] || compMoving[b])
    for (let fi = 0; fi < FV.length; ++fi) {
      if (moving[fi] && pairId[compOf[fi]] !== activeId) {
        dbg?.(`mover face ${fi} outside active pair`)
        return undefined
      }
    }
    const rootLinks = plinks.filter((l) => l.pi === activeId || l.pj === activeId)
    if (rootLinks.length !== 1) { dbg?.(`active pair has ${rootLinks.length} hinge links`); return undefined }
    // root at the biggest pair: every rooting drives the same 1-DOF shape,
    // but anchoring the bulk keeps the model steady on screen. A seamless
    // cover pair must root (children need their own seam creases)
    let rootId = -1
    if (seamlessRoot >= 0) {
      rootId = pairId[seamlessRoot]
      if (rootId === activeId) return undefined
    } else {
      pairComps.forEach(([a, b], pi) => {
        if (pi === activeId) return
        if (rootId < 0 || compArea[a] + compArea[b] > compArea[pairComps[rootId][0]] + compArea[pairComps[rootId][1]]) rootId = pi
      })
    }
    if (rootId < 0) return undefined

    // + side opens up: the flank stacked higher
    const [r0, r1] = pairComps[rootId]
    const root: Pair = {
      a: compLayer[r0] / compArea[r0] >= compLayer[r1] / compArea[r1] ? r0 : r1,
      b: compLayer[r0] / compArea[r0] >= compLayer[r1] / compArea[r1] ? r1 : r0,
      active: false,
      phi: 0,
    }
    const pairs: Pair[] = [root]
    const byId: (Pair | undefined)[] = Array.from({ length: pairComps.length }, () => undefined)
    byId[rootId] = root
    while (pairs.length < pairComps.length) {
      const grew = plinks.some((l) => {
        const havI = byId[l.pi] !== undefined
        const havJ = byId[l.pj] !== undefined
        if (havI === havJ) return false
        const childId = havI ? l.pj : l.pi
        const parPair = byId[havI ? l.pi : l.pj]!
        const childComp = havI ? l.sides[1] : l.sides[0]
        const parComp = havI ? l.sides[0] : l.sides[1]
        const sideA = parComp === parPair.a
        const pair: Pair = {
          a: sideA ? childComp : seamOf[childComp],
          b: sideA ? seamOf[childComp] : childComp,
          parent: parPair,
          hinge: l.line,
          active: childId === activeId,
          phi: 0,
        }
        // seam tip: the far end of the creases joining the pair
        let q: Vec2 | undefined
        let qd = -1
        EV.forEach((ev, ei) => {
          if (!cutEdge[ei]) return
          const fs = EF[ei]
          if (fs.length !== 2) return
          const cc = [compOf[fs[0]], compOf[fs[1]]]
          if (!((cc[0] === pair.a && cc[1] === pair.b) || (cc[0] === pair.b && cc[1] === pair.a))) return
          for (const vi of ev) {
            const d = lineDist(l.line, Vfrom[vi])
            if (d > qd) { qd = d; q = Vfrom[vi] }
          }
        })
        if (!q || qd < LINE_TOL) return false
        pair.q = q
        pairs.push(pair)
        byId[childId] = pair
        return true
      })
      if (!grew) { dbg?.(`tree stuck at ${pairs.length} pairs of ${pairComps.length}`); return undefined }
    }
    const active = byId[activeId]!
    dbg?.(`pairs=${pairs.length} pages=${pages.length} root=${rootId} active=${activeId}`)

    // which mirror side each comp sits on (+1 = the pair's `a`)
    const sideOf = Array.from({ length: nComp }, () => 0)
    for (const pair of pairs) {
      sideOf[pair.a] = 1
      sideOf[pair.b] = -1
    }
    for (const pg of pages) sideOf[pg.comp] = sideOf[pg.parent]

    // ── kinematics ────────────────────────────────────────────────────────
    const idX: Xform = (x) => x
    // place all pairs for a given β; slave hinge angles continue from their
    // stored phi, the active pair's angle is supplied by the caller
    const place = (beta: number, phiActive: number | undefined, commit: boolean): Xform[] | undefined => {
      const T: Xform[] = Array.from({ length: nComp }, () => idX)
      // a seamless cover pair has no joining creases of its own — it
      // opens about the spine the flipping seam sits on
      const rootAxis = seamLine[root.a] ?? seamNow
      const spinUp = rotLine(rootAxis, beta)
      const spinDn = rotLine(rootAxis, -beta)
      T[root.a] = spinUp
      T[root.b] = spinDn
      for (const pair of pairs) {
        if (pair === root) continue
        const Tp = T[pair.parent!.a]
        const q = pair.q!
        const zOf = (phi: number): number =>
          Tp(rotLine(pair.hinge!, phi)([q[0], q[1], 0]))[2]
        let phi: number
        if (pair.active && phiActive !== undefined) {
          phi = phiActive
        } else {
          // A·cosφ + B·sinφ + C = 0, continuing from the pair's last angle
          const g0 = zOf(0)
          const gq = zOf(Math.PI / 2)
          const gp = zOf(Math.PI)
          const A = (g0 - gp) / 2
          const C = (g0 + gp) / 2
          const B = gq - C
          const D = Math.hypot(A, B)
          if (D < 1e-14) {
            // flat start (or a pair riding on the axis): keep its angle
            if (Math.abs(C) > 1e-9) return undefined
            phi = pair.phi
          } else if (Math.abs(gp) < 1e-9) {
            // a reversed point: its pre-reverse tip sat on the spine, so
            // φ=π is a root for every β and the moving branch is single-
            // valued in β — no root picking needed
            phi = 2 * Math.atan2(-g0 / 2, gq - g0 / 2)
            for (const k of [-2 * Math.PI, 2 * Math.PI]) {
              if (Math.abs(phi + k - pair.phi) < Math.abs(phi - pair.phi)) phi += k
            }
          } else {
            // relative slack: at the branch point (D = |C| tangency)
            // roundoff drops D a hair below |C|
            if (D < Math.abs(C) * (1 - 1e-9) - 1e-12) return undefined
            const psi = Math.atan2(B, A)
            const acos = Math.acos(Math.max(-1, Math.min(1, -C / D)))
            const cands = [psi - acos, psi + acos]
            phi = cands[0]
            let bd = Infinity
            for (const c of cands) for (const k of [-2 * Math.PI, 0, 2 * Math.PI]) {
              const cand = c + k
              const d = Math.abs(cand - pair.phi)
              if (d < bd) { bd = d; phi = cand }
            }
          }
        }
        if (commit) pair.phi = phi
        const rotA = rotLine(pair.hinge!, phi)
        const rotB = rotLine(pair.hinge!, -phi)
        const TpA = T[pair.parent!.a]
        const TpB = T[pair.parent!.b]
        T[pair.a] = (x): V3 => TpA(rotA(x))
        T[pair.b] = (x): V3 => TpB(rotB(x))
      }
      // pages fan at half the book angle, counter-rotating about their own
      // hinge so they neither sweep through the opposite cover nor pinch
      // against their parent
      for (const pg of pages) {
        const Tp = T[pg.parent]
        const rot = rotLine(pg.line, -sideOf[pg.parent] * beta / 2)
        T[pg.comp] = (x): V3 => Tp(rot(x))
      }
      return T
    }

    // the active pair's fold branch: z(φ)=0 has the trivial root (its seam
    // tip q sits on the parent seam) and φ = 2·atan2(b,a); β* is where the
    // branches cross
    const foldBranch = (beta: number): number | undefined => {
      const T = place(beta, undefined, false)
      if (!T) return undefined
      const Tp = T[active.parent!.a]
      const q = active.q!
      const zOf = (phi: number): number =>
        Tp(rotLine(active.hinge!, phi)([q[0], q[1], 0]))[2]
      if (Math.abs(zOf(0)) > 1e-9) return undefined  // no trivial root: not this shape
      const gq = zOf(Math.PI / 2)
      const gp = zOf(Math.PI)
      return 2 * Math.atan2(gq - gp / 2, -gp / 2)
    }
    const branchB = (beta: number): number | undefined => {
      const T = place(beta, undefined, false)
      if (!T) return undefined
      const Tp = T[active.parent!.a]
      const q = active.q!
      const zOf = (phi: number): number =>
        Tp(rotLine(active.hinge!, phi)([q[0], q[1], 0]))[2]
      return zOf(Math.PI / 2) - zOf(Math.PI) / 2
    }

    for (const p of pairs) p.phi = 0
    const b0 = branchB(1e-4)
    if (b0 === undefined || Math.abs(b0) < 1e-12) {
      dbg?.(`degenerate fold branch b0=${b0}`)
      return undefined
    }
    // β*: where the fold branch reaches the trivial one — either b crosses
    // zero, or the linkage's solvable domain ends (the branches touch at
    // its boundary); both bracket the same way
    let lo = 1e-4
    let hi: number | undefined
    for (let b = lo; b < Math.PI; b += 0.01) {
      const nb = branchB(b + 0.01)
      if (nb === undefined || nb * b0 <= 0) { hi = b + 0.01; break }
      lo = b + 0.01
    }
    if (hi === undefined) { dbg?.(`betaStar scan found no bracket (lo=${lo.toFixed(3)})`); return undefined }
    let hiN: number = hi
    for (let i = 0; i < 60; ++i) {
      const mid = (lo + hiN) / 2
      const mb = branchB(mid)
      if (mb !== undefined && mb * b0 > 0) lo = mid
      else hiN = mid
    }
    const betaStar = lo

    const vComps: number[][] = Vfrom.map(() => [])
    FV.forEach((F, fi) => {
      for (const vi of F) {
        if (!vComps[vi].includes(compOf[fi])) vComps[vi].push(compOf[fi])
      }
    })

    const frames = (n: number, opts: MechFrameOpts = {}): { pos: number[][]; zdir: number[][] } => {
      for (const p of pairs) p.phi = 0
      const outPos: number[][] = []
      const outDir: number[][] = []
      const betaMax = Math.min(betaStar * (1 - 1e-9), opts.betaCap ?? Infinity)
      const capped = betaMax < betaStar * (1 - 1e-6)
      const smooth01 = (a: number, b: number, x: number): number => {
        const s = Math.min(1, Math.max(0, (x - a) / (b - a)))
        return s * s * (3 - 2 * s)
      }
      const rootAxis = seamLine[root.a] ?? seamNow
      let prevPhi = 0
      let sigmaCap = 0
      for (let k = 0; k < n; ++k) {
        const t = k / (n - 1)
        let beta: number
        let phiA = 0
        if (capped) {
          // capped runs can't reach the branch crossing: open to the cap
          // on the trivial branch (exact), hold while the point sweeps
          // between branches (the only torn stretch, bent across shared
          // vertices), then close riding the fold branch (exact again)
          beta = betaMax * (smooth01(0, 0.35, t) - smooth01(0.65, 1, t))
          if (t <= 0.35) {
            phiA = 0
          } else {
            const raw = foldBranch(Math.max(beta, 1e-6))
            if (raw === undefined) return { pos: outPos, zdir: outDir }
            // canonical branch value in (−π, π], sign pinned by the sweep
            let rep = raw
            while (rep > Math.PI + 1e-9) rep -= 2 * Math.PI
            while (rep <= -Math.PI - 1e-9) rep += 2 * Math.PI
            if (sigmaCap === 0) sigmaCap = rep >= 0 ? 1 : -1
            if (rep * sigmaCap < 0) rep += 2 * Math.PI * sigmaCap
            phiA = t >= 0.65 ? rep : rep * smooth01(0.35, 0.65, t)
          }
        } else {
          beta = betaMax * Math.sin(Math.PI * t)
          if (t > 0.5) {
            const raw = foldBranch(beta)
            if (raw === undefined) return { pos: outPos, zdir: outDir }
            phiA = raw
            for (const cand of [raw - 2 * Math.PI, raw + 2 * Math.PI]) {
              if (Math.abs(cand - prevPhi) < Math.abs(phiA - prevPhi)) phiA = cand
            }
            prevPhi = phiA
          }
        }
        const T = place(beta, phiA, true)
        if (!T) return { pos: outPos, zdir: outDir }
        dbg?.(`frame ${k} beta=${(beta * 180 / Math.PI).toFixed(1)} phis=${pairs.map((p) => (p.phi * 180 / Math.PI).toFixed(1)).join(',')}${pairs.map((p) => (p.active ? '*' : '')).join('')}`)
        // folding on a table: hold the chosen cover flat by undoing its
        // spin on the whole frame (every rooting is the same shape curve)
        const G: Xform = opts.anchor
          ? rotLine(rootAxis, opts.anchor === 'a' ? -beta : beta)
          : idX
        const pos: number[] = []
        Vfrom.forEach((p, vi) => {
          const cs = vComps[vi]
          let x = 0
          let y = 0
          let z = 0
          for (const c of cs) {
            const w = G(T[c]([p[0], p[1], 0]))
            x += w[0] / cs.length
            y += w[1] / cs.length
            z += w[2] / cs.length
          }
          pos.push(x, y, z)
        })
        outPos.push(pos)
        // each assembly carries its ẑ: rotation part applied to (0,0,1)
        const compDir = [...Array(nComp).keys()].map((c) => {
          const o = G(T[c]([0, 0, 0]))
          const zc = G(T[c]([0, 0, 1]))
          return [zc[0] - o[0], zc[1] - o[1], zc[2] - o[2]]
        })
        const zdir: number[] = []
        FV.forEach((_, fi) => zdir.push(...compDir[compOf[fi]]))
        outDir.push(zdir)
      }
      return { pos: outPos, zdir: outDir }
    }

    // sanity: closure at a probe frame — mirror seams must not tear
    for (const p of pairs) p.phi = 0
    const probeT = place(betaStar * 0.6, undefined, false)
    if (!probeT) { dbg?.('probe placement failed'); return undefined }
    let tear = 0
    Vfrom.forEach((p, vi) => {
      const cs = vComps[vi]
      if (cs.length < 2) return
      const w0 = probeT[cs[0]]([p[0], p[1], 0])
      for (const c of cs) {
        const w = probeT[c]([p[0], p[1], 0])
        tear = Math.max(tear, Math.hypot(w[0] - w0[0], w[1] - w0[1], w[2] - w0[2]))
      }
    })
    for (const p of pairs) p.phi = 0
    dbg?.(`betaStar=${(betaStar * 180 / Math.PI).toFixed(2)}° tear=${tear.toExponential(1)}`)
    if (tear > 1e-6) return undefined

    return { frames, betaStar, slavePairs: pairs.length - 2 }
  }

  for (const pl of pageLines) addLine(cuts, { line: pl, kind: 'page' })
  for (let i = 0; i <= escalation.length; ++i) {
    if (i > 0) {
      addLine(cuts, { line: escalation[i - 1].seam, kind: 'seam' })
      addLine(cuts, { line: escalation[i - 1].spine, kind: 'seam' })
      addLine(cuts, { line: escalation[i - 1].hinge, kind: 'hinge' })
    }
    const mech = attempt()
    if (mech) return mech
  }
  return undefined
}
