import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeSample, parseSample, type Sample } from '../src/samples.js'

// The Export/Import wire format: serializeSample -> clipboard -> parseSample
// must reconstruct the scene, and its text must drop straight into SAMPLES.
test('a scene round-trips through serialize -> parse, and pastes into SAMPLES', () => {
  const scene: Sample = {
    name: 'My Scene',
    table: 'path',
    // Backticks and ${…} in the program must survive the template-literal
    // encoding; the expression cell is a string in an otherwise-number column.
    code: 'editable("path", schemas.path) // `beat` drives ${motion}\n',
    tables: {
      path: [
        { beat: 1, px: -1 },
        { beat: 3, py: "=slider('sway').mul(2)" },
        { beat: 5, disabled: true },
      ],
    },
  }
  const text = serializeSample(scene)
  assert.ok(text.startsWith('{') && text.endsWith('},'), 'a trailing-comma SAMPLES entry')
  assert.deepEqual(parseSample(text), scene)
})

test('parseSample rejects clipboard text that is not a scene', () => {
  assert.throws(() => parseSample('just some copied words'))
  assert.throws(() => parseSample('{ name: "no code here" }'))
})
