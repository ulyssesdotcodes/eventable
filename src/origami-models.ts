// The models the examples fold, as data: the rows of a `schemas.origami` table
// plus the pose that shows the finished model off — its two colours and the
// rotation it wants (a crane stands up off the diagonal it started on; a
// flower tips back to be looked into). The DSL's origami("crane") is a model
// from here, and the origami samples seed their editable tables from the same
// rows, so a model is stated once.
import type { Row } from './lineage.js'

export interface OrigamiModelDef {
  /** Fold rows, in schemas.origami's columns — one fold (or turn-over) each. */
  steps: Row[]
  /** spawn() props: the model's colours and how it sits, under the caller's own. */
  pose: Row
}

export const ORIGAMI_MODELS = {
  crane: {
    pose: { color: 0xf4efe2, backColor: 0xd94f2a, pz: 1.2, rz: 2.356 },
    steps: [
      // in half along the diagonal
      { step: "diag", p1: "0,0", p2: "1,1", move: "0.667,0.333", beat: 1, dur: 2 },
      // collapse into the square base: four inside reverse folds
      { step: "overcollapse1", kind: "turn", beat: 3, dur: 1 },
      { step: "collapse1", p1: "0,0.5", p2: "1,0.5", move: "0.333,0.167", kind: "reverse", beat: 4, dur: 2 },
      { step: "overcollapse2", kind: "turn", beat: 6, dur: 1 },
      { step: "collapse2", p1: "0.5,0", p2: "0.5,1", move: "0.833,0.667", kind: "reverse", beat: 7, dur: 2 },
      { step: "collapse3", p1: "0,1", p2: "0.4142135624,0", move: "0.667,0.069036", kind: "reverse", beat: 10, dur: 2 },
      { step: "collapse4", p1: "0,1", p2: "1,0.5857864376", move: "0.930964,0.667", kind: "reverse", beat: 13, dur: 2 },
      // flatten the stray flap, then tuck the side corners in
      { step: "flatten", p1: "0,0.2928932188", p2: "0.7071067812,1", move: "0.930964,0.333", beat: 16, dur: 2 },
      { step: "overtuck1", kind: "turn", beat: 18, dur: 1 },
      { step: "tuck1", p1: "0,1", p2: "0.4142135624,0", move: "0.069036,0.667", kind: "reverse", beat: 19, dur: 2 },
      { step: "tuck2", p1: "0,1", p2: "1,0.5857864376", move: "0.667,0.930964", kind: "reverse", beat: 22, dur: 2 },
      // kite folds onto the centre line, front then (after turning a flap
      // like a page) back — this thins the points into neck and tail
      { step: "overkite1", kind: "turn", beat: 24, dur: 1 },
      { step: "kite1", p1: "0,1", p2: "0.6681786379,0", move: "0.525373,0.274808", pick: 1, beat: 25, dur: 2 },
      { step: "kite2", p1: "0,1", p2: "1,0.3318213621", move: "0.897812,0.667", beat: 28, dur: 2 },
      { step: "overturn", kind: "turn", beat: 30, dur: 1 },
      { step: "turn", p1: "0,0.2928932188", p2: "0.7071067812,1", move: "0.333,0.930964", beat: 31, dur: 2 },
      { step: "kite3", p1: "0,1", p2: "1,0.3318213621", move: "0.667,0.897812", pick: 1, beat: 34, dur: 2 },
      { step: "kite4", p1: "0,1", p2: "0.6681786379,0", move: "0.208238,0.583899", pick: 1, beat: 37, dur: 2 },
      // swing the points up: neck, tail, then the head, all reverse folds
      { step: "neck", p1: "0.1345593806,0", p2: "0.4733251916,1", move: "0.906033,0.694263", kind: "reverse", beat: 40, dur: 2 },
      { step: "tail", p1: "0,0.5266748083", p2: "1,0.8654406193", move: "0.246505,0.203815", kind: "reverse", beat: 43, dur: 2 },
      { step: "head", p1: "0,0.1274716613", p2: "1,0.8431274379", move: "0.096435,0.080352", kind: "reverse", beat: 46, dur: 2 },
      // both wings at once — front sheet and back sheet — held half-raised
      { step: "wings", p1: "0,0.1414213562", p2: "0.8585786438,1", move: "0.858,0.377;0.377,0.858", beat: 49, dur: 4, to: 0.5 },
    ],
  },
  cicada: {
    pose: { color: 0xf4efe2, backColor: 0x79b356, pz: 1.2, rz: -0.785 },
    steps: [
      // in half along the diagonal: the triangle, point down
      { step: "half", p1: "0,0", p2: "1,1", move: "0.667,0.333", beat: 1, dur: 2 },
      // both corners up to the top point
      { step: "overcornerL", kind: "turn", beat: 3, dur: 1 },
      { step: "cornerL", p1: "0,0.5", p2: "1,0.5", move: "0.1,0.3;0.3,0.1", beat: 4, dur: 2 },
      { step: "overcornerR", kind: "turn", beat: 6, dur: 1 },
      { step: "cornerR", p1: "0.5,0", p2: "0.5,1", move: "0.6,0.8;0.8,0.6", beat: 7, dur: 2 },
      // wings: sweep each tip back down so they point away from each
      // other and stick out past the triangle's edges
      { step: "overwingL", kind: "turn", beat: 9, dur: 1 },
      { step: "wingL", p1: "0.19885,0.598479", p2: "1.001892,0.99618", move: "0.03,0.12;0.12,0.03", beat: 10, dur: 2 },
      { step: "overwingR", kind: "turn", beat: 12, dur: 1 },
      { step: "wingR", p1: "0.401521,0.80115", p2: "0.00382,-0.001892", move: "0.88,0.97;0.97,0.88", beat: 13, dur: 2 },
      // the head: one layer down over the wings, the second stops short —
      // that little gap is the cicada's stripe
      { step: "head1", p1: "-0.19,0.59", p2: "0.41,1.19", move: "0.97,0.03", beat: 16, dur: 2 },
      { step: "overhead2", kind: "turn", beat: 18, dur: 1 },
      { step: "head2", p1: "-0.24,0.64", p2: "0.36,1.24", move: "0.03,0.97", beat: 19, dur: 2 },
      // narrow the body: fold the side corners behind
      { step: "tuckL", p1: "0.09,0.59", p2: "0.39,0.29", move: "0.05,0.55", beat: 22, dur: 2 },
      { step: "overtuckR", kind: "turn", beat: 24, dur: 1 },
      { step: "tuckR", p1: "0.41,0.91", p2: "0.71,0.61", move: "0.45,0.95", beat: 25, dur: 2 },
    ],
  },
  lotus: {
    pose: { color: 0xfff2d6, backColor: 0xe0518a, pz: 1.2, rx: -0.22, rz: 0.785 },
    steps: [
      // blintz: fold all four corners to the centre
      { step: "overbl1", kind: "turn", beat: 1, dur: 0.5 },
      { step: "bl1", p1: "0.5,0", p2: "0,0.5", move: "0.05,0.05", beat: 2, dur: 0.9 },
      { step: "overbl2", kind: "turn", beat: 3, dur: 0.5 },
      { step: "bl2", p1: "0.5,0", p2: "1,0.5", move: "0.95,0.05", beat: 4, dur: 0.9 },
      { step: "bl3", p1: "1,0.5", p2: "0.5,1", move: "0.95,0.95", beat: 5, dur: 0.9 },
      { step: "bl4", p1: "0.5,1", p2: "0,0.5", move: "0.05,0.95", beat: 6, dur: 0.9 },
      // fold each corner-point back out past the rim: four petals
      { step: "overpetSW", kind: "turn", beat: 7, dur: 0.5 },
      { step: "petSW", p1: "0.65,0", p2: "0,0.65", move: "0.03,0.03", beat: 8, dur: 0.9 },
      { step: "overpetSE", kind: "turn", beat: 9, dur: 0.5 },
      { step: "petSE", p1: "0.35,0", p2: "1,0.65", move: "0.97,0.03", beat: 10, dur: 0.9 },
      { step: "petNE", p1: "1,0.35", p2: "0.35,1", move: "0.97,0.97", beat: 11, dur: 0.9 },
      { step: "petNW", p1: "0,0.35", p2: "0.65,1", move: "0.03,0.97", beat: 12, dur: 0.9 },
      // fold each petal's tip back for a rounded, two-tone petal
      { step: "overtSW", kind: "turn", beat: 13, dur: 0.5 },
      { step: "tSW", p1: "0.42,0", p2: "0,0.42", move: "0.01,0.01", beat: 14, dur: 0.9 },
      { step: "tSE", p1: "0.58,0", p2: "1,0.42", move: "0.99,0.01", beat: 15, dur: 0.9 },
      { step: "tNE", p1: "1,0.58", p2: "0.58,1", move: "0.99,0.99", beat: 16, dur: 0.9 },
      { step: "tNW", p1: "0,0.58", p2: "0.42,1", move: "0.01,0.99", beat: 17, dur: 0.9 },
    ],
  },
  lily: {
    pose: { color: 0xf0eeff, backColor: 0x7a3fc0, pz: 1.2, rx: -0.22 },
    steps: [
      // blintz: fold all four corners to the centre
      { step: "overbl1", kind: "turn", beat: 1, dur: 0.5 },
      { step: "bl1", p1: "0.5,0", p2: "0,0.5", move: "0.05,0.05", beat: 2, dur: 0.9 },
      { step: "overbl2", kind: "turn", beat: 3, dur: 0.5 },
      { step: "bl2", p1: "0.5,0", p2: "1,0.5", move: "0.95,0.05", beat: 4, dur: 0.9 },
      { step: "bl3", p1: "1,0.5", p2: "0.5,1", move: "0.95,0.95", beat: 5, dur: 0.9 },
      { step: "bl4", p1: "0.5,1", p2: "0,0.5", move: "0.05,0.95", beat: 6, dur: 0.9 },
      // pull each corner-point back out past the rim into a petal
      { step: "overpetSW", kind: "turn", beat: 7, dur: 0.5 },
      { step: "petSW", p1: "0.65,0", p2: "0,0.65", move: "0.03,0.03", beat: 8, dur: 0.9 },
      { step: "overpetSE", kind: "turn", beat: 9, dur: 0.5 },
      { step: "petSE", p1: "0.35,0", p2: "1,0.65", move: "0.97,0.03", beat: 10, dur: 0.9 },
      { step: "petNE", p1: "1,0.35", p2: "0.35,1", move: "0.97,0.97", beat: 11, dur: 0.9 },
      { step: "petNW", p1: "0,0.35", p2: "0.65,1", move: "0.03,0.97", beat: 12, dur: 0.9 },
    ],
  },
} satisfies Record<string, OrigamiModelDef>

export type OrigamiModel = keyof typeof ORIGAMI_MODELS

const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback)

/**
 * The same folding, rescaled so it spans `beats` from its first swing — a
 * 52-beat crane and a 12-beat lily both fill one 16-beat pass, which is what
 * lets one be swapped for the other with nothing else to re-time. Beats are
 * 1-indexed, so `beats` beats of folding end exactly where the next pass
 * begins.
 */
export const fitFoldBeats = (steps: Row[], beats: number): Row[] => {
  const last = steps.reduce((m, r) => Math.max(m, num(r.beat, 1) + num(r.dur, 0.75)), 1)
  if (!(beats > 0) || last <= 1) return steps
  const f = beats / (last - 1)
  // Round the START and the END of each swing, never the duration: folds happen
  // strictly one at a time, so a step that began exactly where the one before
  // it landed has to keep doing so after the rescale.
  const at = (b: number): number => Math.round((1 + (b - 1) * f) * 1000) / 1000
  return steps.map((r) => {
    const beat = at(num(r.beat, 1))
    return { ...r, beat, dur: Math.round((at(num(r.beat, 1) + num(r.dur, 0.75)) - beat) * 1000) / 1000 }
  })
}
