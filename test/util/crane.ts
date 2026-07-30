// The 16 validated folds of the traditional crane (fold lines and flap markers
// extracted from line-folder's example sequence, MIT, and replayed exactly
// against it — see notes/origami-research.md §8).
import type { FoldSpec } from '../../src/fold-engine.js'

export const CRANE: FoldSpec[] = [
  { line: [[0.7071067812, -0.7071067812], 0], move: [[0.666667, 0.333333]] },
  { line: [[0, 1], 0.5], move: [[0.333333, 0.166667]], kind: 'Inside Reverse' },
  { line: [[1, 0], 0.5], move: [[0.833333, 0.666667]], kind: 'Inside Reverse' },
  { line: [[0.9238795325, 0.3826834324], 0.3826834324], move: [[0.666667, 0.069036]], kind: 'Inside Reverse' },
  { line: [[0.3826834324, 0.9238795325], 0.9238795325], move: [[0.930964, 0.666667]], kind: 'Inside Reverse' },
  { line: [[0.7071067812, -0.7071067812], -0.2071067812], move: [[0.930964, 0.333333]] },
  { line: [[0.9238795325, 0.3826834324], 0.3826834324], move: [[0.069036, 0.666667]], kind: 'Inside Reverse' },
  { line: [[0.3826834324, 0.9238795325], 0.9238795325], move: [[0.666667, 0.930964]], kind: 'Inside Reverse' },
  { line: [[0.8314696123, 0.555570233], 0.555570233], move: [[0.525373, 0.274808]], pick: 1 },
  { line: [[0.555570233, 0.8314696123], 0.8314696123], move: [[0.897812, 0.666667]] },
  { line: [[-0.7071067812, 0.7071067812], 0.2071067812], move: [[0.333333, 0.930964]] },
  { line: [[0.555570233, 0.8314696123], 0.8314696123], move: [[0.666667, 0.897812]], pick: 1 },
  { line: [[-0.8314696123, -0.555570233], -0.555570233], move: [[0.208238, 0.583899]], pick: 1 },
  { line: [[0.94712842, -0.3208547274], 0.1274450135], move: [[0.906033, 0.694263]], kind: 'Inside Reverse' },
  { line: [[-0.3208547274, 0.94712842], 0.498828679], move: [[0.246505, 0.203815]], kind: 'Inside Reverse' },
  { line: [[-0.5819756983, 0.8132061772], 0.1036607424], move: [[0.096435, 0.080352]], kind: 'Inside Reverse' },
]
