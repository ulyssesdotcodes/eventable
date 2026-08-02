import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initialState, foldStep, lineThrough, animatedPositions, compileFoldTable,
  foldTablePositions, foldPointsAt, foldElementRows, FoldError, type FoldOutcome, type Vec2,
} from '../src/fold-engine.js'
import { CRANE } from './util/crane.js'
import { M } from '../src/vendor/flatfolder/math.js'
import { X } from '../src/vendor/flatfolder/conversion.js'
import { COMP } from '../src/vendor/linefolder/compute.js'

const near = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) < tol
const motion = (out: FoldOutcome) => ({ ...out.anim, FV: out.state.FV })

test('diagonal fold: two faces, valid layer order, exact reflection', () => {
  const st = initialState()
  const out = foldStep(st, {
    line: lineThrough([0, 0], [1, 1]),
    move: [[0.9, 0.1]],
  })
  assert.equal(out.state.FV.length, 2)
  assert.equal(out.type, 'Pureland')
  assert.equal(out.nStates, 2) // flap above or below
  assert.equal(out.state.FO.length, 1)
  // the moved corner (1,0) lands on (0,1)
  const vi = out.state.sheet.findIndex((s) => near(s[0], 1) && near(s[1], 0))
  assert.ok(vi >= 0)
  assert.ok(near(out.state.V[vi][0], 0) && near(out.state.V[vi][1], 1))
  // sheet coords untouched by folding
  for (const s of out.state.sheet) {
    assert.ok(s[0] > -1e-9 && s[0] < 1 + 1e-9 && s[1] > -1e-9 && s[1] < 1 + 1e-9)
  }
})

test('animatedPositions: hinge swing from flat to the folded state', () => {
  const st = initialState()
  const out = foldStep(st, { line: lineThrough([0, 0], [1, 1]), move: [[0.9, 0.1]] })
  const at0 = animatedPositions(motion(out), 0)
  const at1 = animatedPositions(motion(out), 1)
  const mid = animatedPositions(motion(out), 0.5)
  for (let i = 0; i < out.state.V.length; ++i) {
    // t=0 matches the pre-fold flat coords; t=1 matches the folded state
    assert.ok(near(at0[i][0], out.anim.Vfrom[i][0]) && near(at0[i][1], out.anim.Vfrom[i][1]))
    assert.ok(near(at0[i][2], 0) && near(at1[i][2], 0, 1e-6))
    assert.ok(near(at1[i][0], out.state.V[i][0], 1e-6) && near(at1[i][1], out.state.V[i][1], 1e-6))
  }
  // mid-swing the moving corner is out of plane, and edge lengths are rigid
  const vi = out.state.sheet.findIndex((s) => near(s[0], 1) && near(s[1], 0))
  assert.ok(Math.abs(mid[vi][2]) > 0.3)
  const d3 = (a: number[], b: number[]): number =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  for (const F of out.state.FV) {
    for (let j = 0; j < F.length; ++j) {
      const a = F[j], b = F[(j + 1) % F.length]
      const rest = Math.hypot(
        out.anim.Vfrom[a][0] - out.anim.Vfrom[b][0],
        out.anim.Vfrom[a][1] - out.anim.Vfrom[b][1])
      for (const P of [at0, mid, at1]) {
        assert.ok(near(d3(P[a], P[b]), rest, 1e-9), 'edges must stay rigid mid-swing')
      }
    }
  }
})

test('single flap of a stack moves alone when its sheet marker is used', () => {
  let st = initialState()
  st = foldStep(st, { line: lineThrough([0, 0], [1, 1]), move: [[0.9, 0.1]] }).state
  st = foldStep(st, { line: lineThrough([0.5, 0.5], [0, 1]), move: [[0.05, 0.05]] }).state
  const out = foldStep(st, { line: lineThrough([0.25, 0.75], [0.5, 0.5]), move: [[0.02, 0.02]] })
  assert.equal(out.nStates, 1)
  assert.ok(out.anim.moving.some(Boolean) && !out.anim.moving.every(Boolean))
})

test('verifier errors: bad marker, degenerate move sets, unknown kind', () => {
  const st = initialState()
  assert.throws(() => foldStep(st, {
    line: lineThrough([0, 0], [1, 1]), move: [[2.5, 2.5]],
  }), FoldError)
  // line misses the sheet: the only flap is the whole model
  assert.throws(() => foldStep(st, {
    line: lineThrough([2, 0], [2, 1]), move: [[0.5, 0.5]],
  }), FoldError)
  assert.throws(() => foldStep(st, {
    line: lineThrough([0, 0], [1, 1]), move: [[0.9, 0.1]], kind: 'Banana',
  }), FoldError)
})

const CRANE_FACES = [2, 4, 6, 8, 10, 11, 13, 15, 20, 25, 26, 31, 36, 44, 52, 60]

test('the 16-fold crane sequence solves exactly, step by step', () => {
  let st = initialState()
  CRANE.forEach((spec, i) => {
    const out = foldStep(st, spec)
    assert.equal(out.state.FV.length, CRANE_FACES[i], `step ${i + 1} face count`)
    assert.ok(out.state.layers.length === out.state.FV.length, `step ${i + 1} layers`)
    if (spec.kind !== undefined) assert.equal(out.type, spec.kind, `step ${i + 1} kind`)
    // hinge invariant: every vertex shared by a moving and a static face
    // lies on the fold line — the swing can never tear
    const owner: (boolean | undefined)[] = out.anim.Vfrom.map(() => undefined)
    const [u, d] = out.anim.line
    for (let fi = 0; fi < out.state.FV.length; ++fi) {
      for (const vi of out.state.FV[fi]) {
        if (owner[vi] === undefined) owner[vi] = out.anim.moving[fi]
        else if (owner[vi] !== out.anim.moving[fi]) {
          const h = out.anim.Vfrom[vi][0] * u[0] + out.anim.Vfrom[vi][1] * u[1] - d
          assert.ok(Math.abs(h) < 1e-9, `step ${i + 1}: hinge vertex off the axis`)
          owner[vi] = out.anim.moving[fi]
        }
      }
    }
    st = out.state
  })
  // the folded crane is a small flat model with a full layer stack
  assert.equal(st.FV.length, 60)
  assert.equal(new Set(st.layers).size, st.layers.length)
  // sheet coords still cover the unit square (nothing lost or distorted)
  for (const s of st.sheet) {
    assert.ok(s[0] > -1e-6 && s[0] < 1 + 1e-6 && s[1] > -1e-6 && s[1] < 1 + 1e-6)
  }
})

test('editable-table rows: blank cells ("" and NaN) mean unset, not zero', () => {
  // the table panel materializes every schema column, so untouched cells
  // arrive as empty strings / NaN — they must fall back to defaults
  const program = compileFoldTable([{
    step: 'diag', p1: '0,0', p2: '1,1', move: '0.9,0.1',
    kind: '', pick: NaN, beat: '', dur: '', to: '',
  }])
  assert.equal(program.steps.length, 1)
  assert.equal(program.steps[0].t0, 1)     // beat defaulted, not Number('') = 0
  assert.equal(program.steps[0].t1, 1.75)  // dur defaulted
  assert.equal(program.steps[0].to, 1)     // to defaulted, not 0 (no swing)
  // blank step names get positional defaults; blank p1 errors by name
  assert.throws(() => compileFoldTable([{ step: '', p1: '', p2: '1,1', move: '0.9,0.1' }]),
    (e: Error) => e instanceof FoldError && e.message.includes('"fold1"'))
  // the table panel defaults number columns to 0 — also unset, never
  // "swing at beat 0", "zero-length swing" or "don't fold at all"
  const zeroed = compileFoldTable([{
    step: 'diag', p1: '0,0', p2: '1,1', move: '0.9,0.1',
    kind: '', pick: 0, beat: 0, dur: 0, to: 0,
  }])
  assert.equal(zeroed.steps[0].t0, 1)
  assert.equal(zeroed.steps[0].t1, 1.75)
  assert.equal(zeroed.steps[0].to, 1)
})

test('swing direction follows the target stacking (both picks of a fold)', () => {
  const st = initialState()
  const outs = [0, 1].map((pick) => foldStep(st, {
    line: lineThrough([0, 0], [1, 1]), move: [[0.9, 0.1]], pick,
  }))
  for (const out of outs) {
    const mover = out.anim.moving.findIndex(Boolean)
    const still = out.anim.moving.findIndex((m) => !m)
    const endsOnTop = out.state.layers[mover] > out.state.layers[still]
    const vi = out.state.sheet.findIndex((p) => near(p[0], 1) && near(p[1], 0))
    const midZ = animatedPositions(motion(out), 0.5)[vi][2]
    assert.equal(Math.sign(midZ), endsOnTop ? 1 : -1, 'flap swings on its landing side')
  }
})

test('independent flaps in one step swing to the sides they land on', () => {
  // the crane's wings fold both sheets in one step: the front wing lands
  // on top of the body, the back wing underneath — they must mirror
  let st = initialState()
  for (const spec of CRANE) st = foldStep(st, spec).state
  const out = foldStep(st, {
    line: [[-0.7071067811865475, 0.7071067811865475], 0.1],
    move: [[0.858, 0.377], [0.377, 0.858]],
  })
  const senses = new Set(out.anim.dirs.filter((_, fi) => out.anim.moving[fi]))
  assert.deepEqual([...senses].sort(), [-1, 1], 'the two wings get opposite senses')
  const mid = animatedPositions(motion(out), 0.5)
  const zs = mid.map((p) => p[2]).filter((z) => Math.abs(z) > 1e-6)
  assert.ok(zs.some((z) => z > 0) && zs.some((z) => z < 0), 'wings mirror in ±z')
})

test('a moving face straddling the fold line stays rigid mid-swing', () => {
  // fold the left third over, then fold a line through the overhanging
  // flap with both sides moving: the re-merged face spans the line and
  // must still swing as one rigid piece (regression: |h|-based z broke it)
  let st = initialState()
  st = foldStep(st, { line: lineThrough([1 / 3, 0], [1 / 3, 1]), move: [[0.1, 0.5]] }).state
  const out = foldStep(st, { line: lineThrough([0.55, 0], [0.55, 1]), move: [[0.45, 0.5], [0.05, 0.5]] })
  const d3 = (a: number[], b: number[]): number =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  for (const t of [0.25, 0.5, 0.75]) {
    const P = animatedPositions(motion(out), t)
    for (const F of out.state.FV) {
      for (let j = 0; j < F.length; ++j) {
        const a = F[j], b = F[(j + 1) % F.length]
        const rest = Math.hypot(
          out.anim.Vfrom[a][0] - out.anim.Vfrom[b][0],
          out.anim.Vfrom[a][1] - out.anim.Vfrom[b][1])
        assert.ok(near(d3(P[a], P[b]), rest, 1e-9), `edge rigid at t=${t}`)
      }
    }
  }
})

test('layer indices match flat-folder\'s own per-cell stacking (crane)', () => {
  let st = initialState()
  for (const spec of CRANE) st = foldStep(st, spec).state
  const [FOLD, CELL] = COMP.V_FV_2_FOLD_CELL(st.V, st.FV)
  const { Ff } = FOLD
  const CD = X.CF_edges_2_CD(CELL.CF, st.FO.map(([f1, f2, o]) =>
    M.encode(((Ff[f2] ? 1 : -1) * o >= 0) ? [f1, f2] : [f2, f1])))
  let cells = 0
  for (const S of CD) {
    if (!S || S.length < 2) continue
    cells++
    for (let i = 1; i < S.length; ++i) {
      assert.ok(st.layers[S[i]] > st.layers[S[i - 1]],
        'bigger layer index = higher in the stack, everywhere')
    }
  }
  assert.ok(cells > 10, 'the folded crane has real multi-layer cells')
})

test('nudges are continuous across every step boundary (crane)', () => {
  // each step's layersFrom must be the previous state's stacking carried
  // onto the new face set: look the parent face up by sheet centroid
  // (unique in sheet space, so this is ply-exact)
  let st = initialState()
  const inPoly = (pt: Vec2, poly: Vec2[]): boolean => {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]
      const [xj, yj] = poly[j]
      if ((yi > pt[1]) !== (yj > pt[1]) &&
          pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }
  for (const spec of CRANE) {
    const out = foldStep(st, spec)
    for (let fi = 0; fi < out.state.FV.length; ++fi) {
      const F = out.state.FV[fi]
      const c: Vec2 = [0, 0]
      for (const vi of F) { c[0] += out.state.sheet[vi][0] / F.length; c[1] += out.state.sheet[vi][1] / F.length }
      const parent = st.FV.findIndex((G) => inPoly(c, G.map((vi) => st.sheet[vi])))
      assert.ok(parent >= 0, 'every face has a parent ply')
      assert.equal(out.anim.layersFrom[fi], st.layers[parent], 'pre-swing nudge = parent ply nudge')
    }
    st = out.state
  }
})

test('program zOff eases from the previous stacking to the final one', () => {
  const program = compileFoldTable([
    { step: 'a', p1: '0,0', p2: '1,1', move: '0.9,0.1' },
    { step: 'b', p1: '0.5,0.5', p2: '0,1', move: '0.05,0.05' },
  ])
  const mid = program.maxLayer / 2
  const atStart = foldTablePositions(program, 1)      // step b at t=0
  const atEnd = foldTablePositions(program, 2)        // step b landed
  const stepB = program.steps[1]
  for (let fi = 0; fi < stepB.FV.length; ++fi) {
    assert.ok(near(atStart.zOff[fi], program.gap * (stepB.layersFrom[fi] - mid)))
    assert.ok(near(atEnd.zOff[fi], program.gap * (stepB.layers[fi] - mid)))
  }
  // mid-swing the moving flap is out of plane, all of it on one side
  const midway = foldTablePositions(program, 1.5)
  const movingZ = midway.pos
    .filter((_, vi) => stepB.FV.some((F, fi) => stepB.moving[fi] && F.includes(vi)))
    .map((p) => p[2])
  const outOfPlane = movingZ.filter((z) => Math.abs(z) > 1e-6)
  assert.ok(outOfPlane.length > 0)
  assert.equal(new Set(outOfPlane.map(Math.sign)).size, 1)
})

test('soft in-betweens: baked for reverse folds, exact at both endpoints', () => {
  const rows = [
    { step: 'diag', p1: '0,0', p2: '1,1', move: '0.9,0.1' },
    { step: 'rev', p1: '0,0.5', p2: '1,0.5', move: '0.333333,0.166667', kind: 'reverse' },
  ]
  const program = compileFoldTable(rows)
  assert.equal(program.steps[0].soft, undefined, 'simple folds stay rigid')
  assert.ok(program.steps[1].soft, 'reverse folds get a baked motion')
  const step = program.steps[1]
  // endpoints are the exact states, bit-for-bit with the rigid path
  const atStart = foldTablePositions(program, 1)
  for (let vi = 0; vi < step.Vfrom.length; ++vi) {
    assert.ok(near(atStart.pos[vi][0], step.Vfrom[vi][0], 1e-9))
    assert.ok(near(atStart.pos[vi][1], step.Vfrom[vi][1], 1e-9))
    assert.ok(near(atStart.pos[vi][2], 0, 1e-9))
  }
  const atEnd = foldTablePositions(program, 2)
  for (const p of atEnd.pos) assert.ok(near(p[2], 0, 1e-9), 'landed flat')
  // mid-swing: out of plane, and the paper stays nearly inextensible
  const mid = foldTablePositions(program, 1.5)
  assert.ok(Math.max(...mid.pos.map((p) => Math.abs(p[2]))) > 0.2)
  for (const F of step.FV) {
    for (let j = 0; j < F.length; ++j) {
      const a = F[j], b = F[(j + 1) % F.length]
      const rest = Math.hypot(
        step.Vfrom[a][0] - step.Vfrom[b][0], step.Vfrom[a][1] - step.Vfrom[b][1])
      const now = Math.hypot(
        mid.pos[a][0] - mid.pos[b][0], mid.pos[a][1] - mid.pos[b][1], mid.pos[a][2] - mid.pos[b][2])
      // reverse folds have no rigid path: the paper must transiently bow
      // (the pocket bulges); it must never look rubbery or blow up
      assert.ok(Math.abs(now - rest) < rest * 0.2 + 1e-6, 'soft paper bows, never balloons')
    }
  }
})

test('soft baking is deterministic', () => {
  const rows = [
    { step: 'diag', p1: '0,0', p2: '1,1', move: '0.9,0.1' },
    { step: 'rev', p1: '0,0.5', p2: '1,0.5', move: '0.333333,0.166667', kind: 'reverse' },
  ]
  const a = compileFoldTable(rows).steps[1].soft!
  const b = compileFoldTable(rows).steps[1].soft!
  assert.deepEqual(a, b)
})

test('held folds (to < 1) keep the rigid swing — the pose stays exact', () => {
  const rows = [
    { step: 'diag', p1: '0,0', p2: '1,1', move: '0.9,0.1' },
    { step: 'rev', p1: '0,0.5', p2: '1,0.5', move: '0.333333,0.166667', kind: 'reverse', to: 0.5 },
  ]
  const program = compileFoldTable(rows)
  assert.equal(program.steps[1].soft, undefined)
  const held = foldTablePositions(program, 1.5)
  const step = program.steps[1]
  for (const F of step.FV) {
    for (let j = 0; j < F.length; ++j) {
      const a = F[j], b = F[(j + 1) % F.length]
      const rest = Math.hypot(step.Vfrom[a][0] - step.Vfrom[b][0], step.Vfrom[a][1] - step.Vfrom[b][1])
      const now = Math.hypot(held.pos[a][0] - held.pos[b][0], held.pos[a][1] - held.pos[b][1], held.pos[a][2] - held.pos[b][2])
      assert.ok(near(now, rest, 1e-9), 'held pose is rigid')
    }
  }
})

test('crease rows: cut every ply, fold nothing, take no timeline slot', () => {
  const rows = [
    { step: 'diag', p1: '0,0', p2: '1,1', move: '0.9,0.1' },
    { step: 'pre', p1: '0,0.5', p2: '1,0.5', kind: 'crease' },
    { step: 'book', p1: '0.25,0', p2: '0.25,1', move: '0.05,0.05' },
  ]
  const program = compileFoldTable(rows)
  const plain = compileFoldTable(rows.filter((r) => r.kind !== 'crease'))
  assert.equal(program.steps.length, 2)
  assert.equal(program.steps[1].t0, 2, 'crease rows do not shift the schedule')
  assert.ok(program.steps[1].FV.length > plain.steps[1].FV.length,
    'the pre-crease subdivided the sheet')
  const { pos } = foldTablePositions(program, 1)
  for (const p of pos) assert.ok(Math.abs(p[2]) < 1e-9)
})

// Attribute rows are timed like the fold they describe, so adding an id and
// an event makes them scene/post events with no further mapping. That timing
// is what lets colouring be a separate pipeline from spawning the paper.
test('every attribute row carries its own fold\'s beat and duration', () => {
  const program = compileFoldTable([
    { step: 'diag', p1: '0,0', p2: '1,1', move: '0.9,0.1', beat: 2, dur: 3 },
    { step: 'book', p1: '0.5,0.5', p2: '0,1', move: '0.05,0.05', beat: 6, dur: 1 },
  ])
  assert.deepEqual(program.folds.map((r) => [r.step, r.beat, r.dur]), [[0, 2, 3], [1, 6, 1]])
  for (const rows of [program.faces, program.edges]) {
    for (const r of rows) {
      const fold = program.folds[r.step as number]
      assert.equal(r.beat, fold.beat)
      assert.equal(r.dur, fold.dur)
    }
  }
})

// face -> points: sampling an element at a fraction of its OWN fold, so one
// call gives every step the same moment in its swing.
test('foldPointsAt places each element where its own fold has reached', () => {
  const program = compileFoldTable([
    { step: 'diag', p1: '0,0', p2: '1,1', move: '0.9,0.1' },
    { step: 'book', p1: '0.5,0.5', p2: '0,1', move: '0.05,0.05' },
  ])
  const flat = foldPointsAt(program, program.faces, 0)
  const mid = foldPointsAt(program, program.faces, 0.5)
  for (const r of [...flat, ...mid]) {
    for (const k of ['px', 'py', 'pz']) assert.equal(typeof r[k], 'number')
  }
  // a face that swings leaves the plane mid-fold; one that stays put does not
  const movers = mid.filter((r) => r.moving)
  const still = mid.filter((r) => !r.moving)
  assert.ok(movers.length && still.length)
  assert.ok(movers.some((r) => Math.abs(r.pz as number) > 0.05), 'a mover lifts')
  const pairs = new Map(flat.map((r) => [`${r.step}:${r.face}`, r]))
  for (const r of still) {
    const was = pairs.get(`${r.step}:${r.face}`)!
    assert.ok(Math.abs((r.px as number) - (was.px as number)) < 1e-6, 'still paper stays put')
  }
})

// Face numbering is what makes per-face attributes addressable: it must hold
// for a whole swing and may only change when a fold lands.
test('a face keeps its number for the whole of its step', () => {
  const program = compileFoldTable([
    { step: 'diag', p1: '0,0', p2: '1,1', move: '0.9,0.1' },
    { step: 'book', p1: '0.5,0.5', p2: '0,1', move: '0.05,0.05' },
  ])
  const mid = foldTablePositions(program, 1.5)
  assert.equal(mid.step, 1)
  assert.equal(foldTablePositions(program, 1).FV, mid.FV, 'same faces all swing')
  assert.equal(foldTablePositions(program, 1.99).FV, mid.FV)
  assert.notEqual(foldTablePositions(program, 0.5).FV, mid.FV, 'renumbered by the fold')
})

// The creases a fold TURNS are not the creases lying on its fold line: the
// line also cuts creases it merely crosses, and a reverse fold opens a spine
// crease nowhere near it. `folds` is the former; anything testing the line
// itself mismarks every reverse fold.
test('edge rows mark the creases the fold turns, not the ones on its line', () => {
  const program = compileFoldTable([
    { step: 'diag', p1: '0,0', p2: '1,1', move: '0.667,0.333' },
    { step: 'rev', p1: '0,0.5', p2: '1,0.5', move: '0.333,0.167', kind: 'reverse' },
  ])
  const step = program.steps[1]
  const [u, d] = step.line
  const onLine = (vi: number): boolean =>
    Math.abs(step.Vfrom[vi][0] * u[0] + step.Vfrom[vi][1] * u[1] - d) < 1e-6
  const turning = program.edges.filter((r) => r.step === 1 && r.folds)
  assert.ok(turning.length > 0, 'a fold turns at least one crease')
  assert.ok(turning.some((r) => !(onLine(r.a as number) && onLine(r.b as number))),
    'a reverse fold turns a crease off its own fold line')
  for (const r of turning) assert.ok(r.mv === 'M' || r.mv === 'V')
})

// `layers` is a stacking ORDER — a permutation, one rank per face. The count
// of sheets actually piled up at a face is a different number entirely.
test('face rows carry ply depth, distinct from the stacking rank', () => {
  const program = compileFoldTable([
    { step: 'diag', p1: '0,0', p2: '1,1', move: '0.667,0.333' },
    { step: 'rev', p1: '0,0.5', p2: '1,0.5', move: '0.333,0.167', kind: 'reverse' },
  ])
  const faces = program.faces.filter((r) => r.step === 1)
  assert.equal(faces.length, program.steps[1].FV.length, 'one row per face')
  const ranks = faces.map((r) => r.layer as number).sort((a, b) => a - b)
  assert.deepEqual(ranks, ranks.map((_, i) => i), 'layer is a rank, not a count')
  for (const r of faces) {
    assert.ok((r.plies as number) >= 1 && (r.plies as number) <= faces.length)
    assert.equal(typeof r.moving, 'boolean')
  }
  assert.ok(faces.some((r) => r.moving), 'the fold moves something')
  assert.ok(faces.some((r) => !r.moving), 'and leaves something still')
})

// The paper is addressable as corners, creases and faces — one numbering,
// shared by the rows and the renderer, meaningful only inside its own fold.
test('every fold reports its corners, creases and faces in one numbering', () => {
  const program = compileFoldTable([
    { step: 'diag', p1: '0,0', p2: '1,1', move: '0.667,0.333' },
    { step: 'rev', p1: '0,0.5', p2: '1,0.5', move: '0.333,0.167', kind: 'reverse' },
  ])
  // The renderer draws ONE topology for the whole folding, so an attribute row
  // must address the element it draws — not the face its own fold happened to
  // split the paper into, which is different paper on every step but the last.
  const drawn = foldElementRows(program, { id: 'p' }).filter((r) => r.event === 'create')
  const drawnFaces = new Set(drawn.filter((r) => r.tri == null && typeof r.face === 'number').map((r) => r.face))
  const drawnEdges = new Set(drawn.filter((r) => typeof r.edge === 'number').map((r) => r.edge))
  for (let k = 0; k < program.steps.length; k++) {
    const verts = program.verts.filter((r) => r.step === k)
    const faces = program.faces.filter((r) => r.step === k)
    const edges = program.edges.filter((r) => r.step === k)
    assert.deepEqual(new Set(faces.map((r) => r.face)), drawnFaces, 'every drawn face has a row')
    assert.ok(edges.every((r) => drawnEdges.has(r.edge)), 'every crease row names a drawn crease')
    assert.equal(verts.length, program.steps[k].Vfrom.length, 'one row per corner')
    // every corner a face names has a row, and the numbering is the same one
    for (const F of program.steps[k].FV) {
      for (const vi of F) assert.ok(verts.some((r) => r.vert === vi), `corner ${vi} has a row`)
    }
    // the fold turns the paper about its hinge corners, so a fold has some
    assert.ok(verts.some((r) => r.hinge), 'the fold line runs through corners')
    assert.ok(verts.some((r) => r.moving), 'and some corners belong to moving paper')
  }
})
