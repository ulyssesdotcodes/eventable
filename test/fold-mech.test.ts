import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initialState, foldStep, compileFoldTable, foldTablePositions, type FoldState, type Vec2,
} from '../src/fold-engine.js'
import { CRANE } from './util/crane.js'
import { buildReverseMech, reverseRecordOf, type ReverseRecord } from '../src/fold-mech.js'

const edgeSet = (FV: number[][]): [number, number][] => {
  const seen = new Set<string>()
  const out: [number, number][] = []
  for (const F of FV) {
    let i = F.length - 1
    for (let j = 0; j < F.length; ++j) {
      const key = `${Math.min(F[i], F[j])}:${Math.max(F[i], F[j])}`
      if (!seen.has(key)) { seen.add(key); out.push([Math.min(F[i], F[j]), Math.max(F[i], F[j])]) }
      i = j
    }
  }
  return out
}

// run the crane up to a step, with the reverse-fold history the engine
// would have accumulated
const craneAt = (idx: number): { out: ReturnType<typeof foldStep>; history: ReverseRecord[] } => {
  let st: FoldState = initialState()
  const history: ReverseRecord[] = []
  for (let i = 0; i < idx; ++i) {
    const out = foldStep(st, CRANE[i])
    const rec = reverseRecordOf(out)
    if (rec) history.push(rec)
    st = out.state
  }
  return { out: foldStep(st, CRANE[idx]), history }
}

test('deep reverse folds (neck, tail, head) get an exact rigid mechanism', () => {
  for (const idx of [13, 14, 15]) {
    const { out, history } = craneAt(idx)
    const mech = buildReverseMech(out, history)
    assert.ok(mech, `step ${idx + 1} builds a mechanism`)
    const { pos: frames, zdir } = mech.frames(16)
    assert.equal(frames.length, 16, `step ${idx + 1} bakes all frames`)
    assert.equal(zdir.length, 16, `step ${idx + 1} bakes offset directions`)
    // offset directions are exact world z at both flat endpoints
    for (const f of [zdir[0], zdir[15]]) {
      for (let fi = 0; fi * 3 < f.length; ++fi) {
        assert.ok(Math.abs(Math.abs(f[fi * 3 + 2]) - 1) < 1e-9, `step ${idx + 1} endpoint zdir vertical`)
      }
    }

    out.anim.Vfrom.forEach((p, vi) => {
      assert.ok(Math.hypot(frames[0][vi * 3] - p[0], frames[0][vi * 3 + 1] - p[1], frames[0][vi * 3 + 2]) < 1e-8,
        `step ${idx + 1} starts flat`)
    })
    out.state.V.forEach((p, vi) => {
      const f = frames[15]
      assert.ok(Math.hypot(f[vi * 3] - p[0], f[vi * 3 + 1] - p[1], f[vi * 3 + 2]) < 1e-8,
        `step ${idx + 1} lands on the solved state`)
    })

    const edges = edgeSet(out.state.FV)
    const rest = edges.map(([a, b]) => {
      const p = out.anim.Vfrom[a]
      const q = out.anim.Vfrom[b]
      return Math.hypot(p[0] - q[0], p[1] - q[1])
    })
    for (const f of frames) {
      edges.forEach(([a, b], ei) => {
        const len = Math.hypot(
          f[a * 3] - f[b * 3], f[a * 3 + 1] - f[b * 3 + 1], f[a * 3 + 2] - f[b * 3 + 2])
        assert.ok(Math.abs(len - rest[ei]) < 1e-7, `step ${idx + 1} keeps edge ${a}-${b} rigid`)
      })
    }

    let maxZ = 0
    for (const f of frames) {
      for (let vi = 0; vi * 3 < f.length; ++vi) maxZ = Math.max(maxZ, Math.abs(f[vi * 3 + 2]))
    }
    assert.ok(maxZ > 0.05, `step ${idx + 1} swings through 3D (maxZ=${maxZ})`)
  }
})

test('the mechanism is deterministic', () => {
  const { out, history } = craneAt(13)
  const a = buildReverseMech(out, history)!.frames(9)
  const b = buildReverseMech(out, history)!.frames(9)
  assert.deepEqual(a.pos, b.pos)
  assert.deepEqual(a.zdir, b.zdir)
})

test('compiled crane bakes the deep reverses and keeps flat states exact', () => {
  const rows = CRANE.map((spec, i) => {
    const [u, d] = spec.line
    const dir: Vec2 = [-u[1], u[0]]
    const p1: Vec2 = [u[0] * d, u[1] * d]
    const p2: Vec2 = [p1[0] + dir[0], p1[1] + dir[1]]
    return {
      step: `s${i + 1}`,
      p1: `${p1[0]},${p1[1]}`, p2: `${p2[0]},${p2[1]}`,
      move: spec.move.map((m) => m.join(',')).join(';'),
      kind: spec.kind === 'Inside Reverse' ? 'reverse' : '',
      pick: spec.pick ?? 0,
      beat: i + 1,
    }
  })
  const program = compileFoldTable(rows, { size: 1 })
  const deep = program.steps.filter((s) => s.FV.length > 20 && s.type !== 'Pureland')
  assert.ok(deep.length >= 3, 'the crane has deep non-simple steps')
  for (const s of deep) {
    assert.ok(s.soft, `step ${s.name} bakes motion`)
  }
  for (let k = 0; k <= program.steps.length; ++k) {
    const { pos } = foldTablePositions(program, k)
    for (const p of pos) assert.ok(Math.abs(p[2]) < 1e-6, `fold ${k} is flat`)
  }
})
