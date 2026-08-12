import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createEditableTableStore, schemaColumns, cellValid, invalidColumns,
  CLEAR_RUNS_KIND, ACTIVITY_TABLE,
  type EditableColumn,
} from '../src/editable-tables.js'
// Registers the "=" cell checker cellValid consults.
import '../src/expr-cell.js'

test('addRow / setCell / removeRow', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  store.addRow('t1')
  store.addRow('t1')
  // A new row starts at beat 1, the top of the loop — beats are 1-indexed.
  assert.deepEqual(store.get('t1')!.rows, [{ beat: 1 }, { beat: 1 }])
  store.setCell('t1', 0, 'beat', 42)
  assert.equal(store.get('t1')!.rows[0].beat, 42)
  store.removeRow('t1', 0)
  assert.deepEqual(store.get('t1')!.rows, [{ beat: 1 }])
})

test('duplicateRow inserts a copy of the row right after it, with its own identity going forward', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  store.addRow('t1')
  store.setCell('t1', 0, 'beat', 3)
  store.addRow('t1')
  store.setCell('t1', 1, 'beat', 9)

  store.duplicateRow('t1', 0)
  assert.deepEqual(store.get('t1')!.rows, [{ beat: 3 }, { beat: 3 }, { beat: 9 }])

  store.setCell('t1', 1, 'beat', 5)
  assert.deepEqual(store.get('t1')!.rows, [{ beat: 3 }, { beat: 5 }, { beat: 9 }])

  assert.equal(store.get('t1')!.rows.length, 3, 'duplicating an out-of-range row is a no-op')
  store.duplicateRow('t1', 99)
  assert.equal(store.get('t1')!.rows.length, 3)
})

test('addColumn backfills existing rows with a default; removeColumn drops it', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  store.addRow('t1')
  store.addColumn('t1', 'label', 'string')
  assert.deepEqual(store.get('t1')!.rows, [{ beat: 1, label: '' }])
  store.removeColumn('t1', 'beat')
  assert.deepEqual(store.get('t1')!.rows, [{ label: '' }])
})

test('a boolean column named "disabled" hides a row from ensure() without deleting it', () => {
  const store = createEditableTableStore()
  store.ensure('kf', { v: 'number' }, [{ v: 1 }, { v: 2 }, { v: 3 }])
  store.addColumn('kf', 'disabled', 'boolean')
  store.setCell('kf', 1, 'disabled', true)

  assert.deepEqual(store.get('kf')!.rows.map((r) => r.v), [1, 2, 3])
  assert.deepEqual(
    store.ensure('kf', { v: 'number' }, [{ v: 1 }, { v: 2 }, { v: 3 }]).map((r) => r.v),
    [1, 3],
  )

  store.setCell('kf', 1, 'disabled', false)
  assert.deepEqual(
    store.ensure('kf', { v: 'number' }, [{ v: 1 }, { v: 2 }, { v: 3 }]).map((r) => r.v),
    [1, 2, 3],
  )
})

test('renameColumn moves the value under the new key', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  store.addRow('t1')
  store.setCell('t1', 0, 'beat', 7)
  assert.ok(store.renameColumn('t1', 'beat', 'score'))
  assert.deepEqual(store.get('t1')!.rows, [{ score: 7 }])
  assert.deepEqual(store.get('t1')!.columns, [{ name: 'score', type: 'number' }])
})

test('renameTable moves state (and its event history) and rejects collisions', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  store.addRow('t1')
  store.createTable('t2')
  assert.ok(store.renameTable('t1', 'scores'))
  assert.ok(!store.has('t1'))
  assert.ok(store.has('scores'))
  assert.deepEqual(store.get('scores')!.events.map((e) => e.kind), ['create', 'add-row', 'rename-table'])
  assert.ok(!store.renameTable('scores', 't2'), 'refuses to clobber an existing table')
})

test('ensure creates on first use (with seed rows), and later re-declares grow/shrink freely — a purely-declared column tracks the schema exactly', () => {
  const store = createEditableTableStore()
  const rows = store.ensure('scores', { name: 'string', score: 'number' }, [{ name: 'ada', score: 100 }])
  assert.deepEqual(rows, [{ name: 'ada', score: 100 }])

  const rows2 = store.ensure('scores', { name: 'string', score: 'number', bonus: 'boolean' })
  assert.deepEqual(rows2, [{ name: 'ada', score: 100, bonus: false }])

  const rows3 = store.ensure('scores', { name: 'string' })
  assert.deepEqual(rows3, [{ name: 'ada' }])
})

test('a column added via the table panel survives even after the program stops declaring the table at all', () => {
  const store = createEditableTableStore()
  store.ensure('scores', { name: 'string' }, [{ name: 'ada' }])
  store.addColumn('scores', 'extra', 'number')
  assert.deepEqual(store.get('scores')!.rows, [{ name: 'ada', extra: 0 }])

  const rows = store.ensure('scores', { name: 'string' })
  assert.deepEqual(rows, [{ name: 'ada', extra: 0 }])
})

test('re-seeding replaces the code rows the user has not touched, and keeps the ones they edited', () => {
  const store = createEditableTableStore()
  store.ensure('kf', { beat: 'number', v: 'number' }, [{ beat: 1, v: 10 }, { beat: 2, v: 20 }, { beat: 3, v: 30 }])
  store.setCell('kf', 1, 'v', 999)
  assert.deepEqual(store.get('kf')!.rows, [{ beat: 1, v: 10 }, { beat: 2, v: 999 }, { beat: 3, v: 30 }])

  store.ensure('kf', { beat: 'number', v: 'number' }, [{ beat: 1, v: 11 }, { beat: 2, v: 22 }, { beat: 3, v: 33 }])
  assert.deepEqual(store.get('kf')!.rows, [{ beat: 1, v: 11 }, { beat: 2, v: 999 }, { beat: 3, v: 33 }])
})

test('re-seeding keeps user-added rows, and never overwrites/drops them', () => {
  const store = createEditableTableStore()
  store.ensure('kf', { v: 'number' }, [{ v: 1 }, { v: 2 }])
  store.addRow('kf')
  store.setCell('kf', 2, 'v', 7) // the user's own row
  assert.deepEqual(store.get('kf')!.rows.map((r) => r.v), [1, 2, 7])

  // Seed shrinks: the surviving code slot re-seeds, the extra pristine code row drops.
  store.ensure('kf', { v: 'number' }, [{ v: 100 }])
  assert.deepEqual(store.get('kf')!.rows.map((r) => r.v), [100, 7])

  // Seed grows again: new code rows append after the user's row.
  store.ensure('kf', { v: 'number' }, [{ v: 100 }, { v: 200 }, { v: 300 }])
  assert.deepEqual(store.get('kf')!.rows.map((r) => r.v), [100, 7, 200, 300])
})

test('a table-panel table is never re-seeded by a later editable() seed (the program never owned its rows)', () => {
  const store = createEditableTableStore()
  store.createTable('t')
  store.addRow('t')
  store.setCell('t', 0, 'beat', 5)
  store.ensure('t', { beat: 'number' }, [{ beat: 9 }])
  assert.deepEqual(store.get('t')!.rows, [{ beat: 5 }])
})

test('re-seeding survives serialize/load — provenance is rebuilt purely from the event log', () => {
  const a = createEditableTableStore()
  a.ensure('kf', { v: 'number' }, [{ v: 1 }, { v: 2 }])
  a.setCell('kf', 0, 'v', 99)

  const b = createEditableTableStore()
  assert.ok(b.load(a.serialize()))
  b.ensure('kf', { v: 'number' }, [{ v: 10 }, { v: 20 }])
  assert.deepEqual(b.get('kf')!.rows.map((r) => r.v), [99, 20])
})

test('retainDeclared prunes a code-created table the program stopped declaring, and only that', () => {
  const store = createEditableTableStore()
  store.ensure('code', { code: 'code' }, [{ code: 'x' }])
  store.ensure('a', { v: 'number' }, [{ v: 1 }])
  store.ensure('b', { v: 'number' }, [{ v: 2 }])
  store.createTable('u')
  store.record('activity', 'apply')

  const removed = store.retainDeclared(['a'])
  assert.deepEqual(removed, ['b'])
  assert.ok(store.has('a'), 'still-declared table stays')
  assert.ok(!store.has('b'), 'undeclared code table is dropped — no longer editable')
  assert.ok(store.has('u'), 'a user "+ table" is never pruned')
  assert.ok(store.has('code'), '"code" is never pruned')
  assert.ok(store.has('activity'), 'a log stream is never pruned')
})

test('retainDeclared is a no-op while replaying a past run', () => {
  const store = createEditableTableStore()
  store.ensure('code', { code: 'code' }, [{ code: 'x' }])
  store.ensure('a', { v: 'number' }, [{ v: 1 }])
  const run = store.recordRun()

  store.setReplayView(run)
  assert.deepEqual(store.retainDeclared([]), [], 'nothing removed during a scrubbed preview')
  store.setReplayView(null)
  assert.ok(store.has('a'), 'the head log is untouched by the replay-time call')
})

test('re-declaring retypes a purely-declared column in place; a column the user retyped keeps its type', () => {
  const store = createEditableTableStore()
  store.ensure('t', { a: 'string' })
  store.addColumn('t', 'b', 'number')
  store.ensure('t', { a: 'number' })
  assert.deepEqual(store.get('t')!.columns, [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }])

  store.setColumnType('t', 'b', 'string')
  store.ensure('t', { a: 'number', b: 'number' })
  assert.deepEqual(store.get('t')!.columns, [{ name: 'a', type: 'number' }, { name: 'b', type: 'string' }], 'the table-panel retype wins')
})

test('removing a column via the table panel keeps it gone even if the program keeps declaring it', () => {
  const store = createEditableTableStore()
  store.ensure('t', { a: 'string', b: 'number' })
  store.removeColumn('t', 'b')
  assert.deepEqual(store.get('t')!.columns.map((c) => c.name), ['a'])

  store.ensure('t', { a: 'string', b: 'number' })
  assert.deepEqual(store.get('t')!.columns.map((c) => c.name), ['a'])
})

test('ensure appends no event when the schema already matches (no event spam per run)', () => {
  const store = createEditableTableStore()
  store.ensure('t', { value: 'number' })
  const before = store.get('t')!.events.length
  store.ensure('t', { value: 'number' })
  store.ensure('t', { value: 'number' })
  assert.equal(store.get('t')!.events.length, before)
})

test('serialize/load round-trips the whole store — the unit a session persists', () => {
  const a = createEditableTableStore()
  a.createTable('t1')
  a.setCell('t1', 0, 'beat', 1) // no row yet — invalid, appends nothing
  a.addRow('t1')
  a.setCell('t1', 0, 'beat', 9)
  a.createTable('t2')

  const b = createEditableTableStore()
  assert.ok(b.load(a.serialize()))
  assert.deepEqual(b.get('t1')!.rows, [{ beat: 9 }])
  assert.deepEqual(b.get('t1')!.events.map((e) => e.kind), ['create', 'add-row', 'set-cell'])
  assert.ok(b.has('t2'), 'every table in the store round-trips, not just one')
})

test('migrates a v1 session whose create event stored the editable() schema object as columns', () => {
  // Before v2, a create event serialized `columns` as the raw editable() schema
  // ({ name: type }) rather than today's [{ name, type }] array.
  const legacyV1 = JSON.stringify({
    version: 1, start: 1,
    events: [{
      kind: 'create', table: 'nums',
      columns: { beat: 'number', px: 'number', disabled: 'boolean' },
      rows: [{ beat: 1, px: 5, disabled: false }, { beat: 2, px: 9, disabled: false }],
      declared: true, seq: 0, t: 0, src: 'a',
    }],
  })
  const store = createEditableTableStore()
  assert.ok(store.load(legacyV1), 'a v1 session with table data loads')
  assert.deepEqual(store.get('nums')!.columns, [
    { name: 'beat', type: 'number' }, { name: 'px', type: 'number' }, { name: 'disabled', type: 'boolean' },
  ], 'columns are recovered from the legacy schema object')
  assert.deepEqual(store.get('nums')!.rows, [
    { beat: 1, px: 5, disabled: false }, { beat: 2, px: 9, disabled: false },
  ], 'the table data is intact')

  const reSaved = JSON.parse(store.serialize())
  assert.equal(reSaved.version, 4)
  assert.ok(Array.isArray(reSaved.events[0].columns))
})

test('migrates a v2 session: post chain/set events become setCode/setVariable, particles set becomes setVariable', () => {
  const legacyV2 = JSON.stringify({
    version: 2, start: 1,
    events: [
      {
        kind: 'create', table: 'post', declared: true,
        columns: [
          { name: 'beat', type: 'number' },
          { name: 'event', type: 'enum', options: ['chain', 'add', 'remove', 'layer', 'transition', 'set', 'pulse'] },
          { name: 'code', type: 'code', language: 'post' },
          { name: 'name', type: 'string' },
          { name: 'value', type: 'number' },
        ],
        rows: [{ beat: 1, event: 'chain', code: 'blur(2)' }, { beat: 1, event: 'pulse', name: 'g', value: 0.2 }],
        seq: 0, t: 0, src: 'a',
      },
      { kind: 'rename-table', table: 'post', to: 'fx', seq: 1, t: 0, src: 'a' },
      { kind: 'set-cell', table: 'fx', row: 1, col: 'event', value: 'set', seq: 2, t: 0, src: 'a' },
      {
        kind: 'create', table: 'particles', declared: true,
        columns: [
          { name: 'beat', type: 'number' },
          { name: 'event', type: 'enum', options: ['spawn', 'set'] },
          { name: 'name', type: 'string' },
          { name: 'value', type: 'number' },
        ],
        rows: [{ beat: 1, event: 'set', name: 'speed', value: 1 }],
        seq: 3, t: 0, src: 'a',
      },
    ],
  })
  const store = createEditableTableStore()
  assert.ok(store.load(legacyV2), 'a v2 session loads')
  const fx = store.get('fx')!
  assert.deepEqual(fx.rows.map((r) => r.event), ['setCode', 'setVariable'],
    'seed rows and cell edits read the new names, followed through a rename-table')
  const options = fx.columns.find((c) => c.name === 'event')!.options!
  assert.ok(options.includes('setCode') && options.includes('setVariable') && !options.includes('chain'))
  // migratePostEventNames leaves particles alone (no 'chain'); the later
  // column-naming migration is what renames particles' own 'set'.
  assert.equal(store.get('particles')!.rows[0].event, 'setVariable', "particles' 'set' folds to 'setVariable'")
  assert.ok(store.get('particles')!.columns.find((c) => c.name === 'event')!.options!.includes('setVariable'))
})

test('column-naming migration (v3→v4): old-shape tables fold to the new columns and events', () => {
  const legacy = JSON.stringify({
    version: 3, start: 1,
    events: [
      // origami: `at` time column → `beat`, edited (set-row) after a rename-table
      {
        kind: 'create', table: 'folds', declared: true,
        columns: [
          { name: 'step', type: 'string' }, { name: 'p1', type: 'string' },
          { name: 'move', type: 'string' }, { name: 'at', type: 'number' }, { name: 'dur', type: 'number' },
        ],
        rows: [{ step: 'diag', p1: '0,0', move: '0.6,0.3', at: 1, dur: 2 }],
        seq: 0, t: 0, src: 'a',
      },
      { kind: 'rename-table', table: 'folds', to: 'crane', seq: 1, t: 0, src: 'a' },
      { kind: 'set-row', table: 'crane', row: 0, values: { at: 6 }, seq: 2, t: 0, src: 'a' },
      // scene: `type` discriminant → `event`, a seeded 'color' row survives, a
      // set-cell on the old `type` column lands on `event`
      {
        kind: 'create', table: 'scene', declared: true,
        columns: [
          { name: 'beat', type: 'number' }, { name: 'id', type: 'string' },
          { name: 'type', type: 'enum', options: ['create', 'update', 'destroy'] },
          { name: 'color', type: 'number' }, { name: 'dur', type: 'number' },
        ],
        rows: [{ beat: 1, id: 'a', type: 'create', color: 0xffffff }, { beat: 5, id: 'a', type: 'color', color: 0xff0000, dur: 2 }],
        seq: 3, t: 0, src: 'a',
      },
      { kind: 'set-cell', table: 'scene', row: 0, col: 'type', value: 'update', seq: 4, t: 0, src: 'a' },
      // sliders: `id` name column → `name`, both a seeded row (edited) and a
      // define-slider (whose wire keeps `id`) fold into `name`
      {
        kind: 'create', table: 'sliders', declared: true,
        columns: [
          { name: 'id', type: 'string' }, { name: 'min', type: 'number' },
          { name: 'max', type: 'number' }, { name: 'default', type: 'number' },
        ],
        rows: [{ id: 'height', min: -1, max: 1, default: 0 }],
        seq: 5, t: 0, src: 'a',
      },
      { kind: 'set-cell', table: 'sliders', row: 0, col: 'id', value: 'depth', seq: 6, t: 0, src: 'a' },
      { kind: 'define-slider', table: 'sliders', src: 'slider:warp', id: 'warp', min: 0, max: 2, seq: 7, t: 0 },
    ],
  })
  const store = createEditableTableStore()
  assert.ok(store.load(legacy), 'the old session loads')

  const crane = store.get('crane')!
  assert.ok(crane.columns.some((c) => c.name === 'beat') && !crane.columns.some((c) => c.name === 'at'))
  assert.equal(crane.rows[0].beat, 6, 'the set-row on `at` landed on `beat`')
  assert.equal('at' in crane.rows[0], false)

  const scene = store.get('scene')!
  assert.ok(scene.columns.find((c) => c.name === 'event')!.options!.includes('color'), 'the color event is a dropdown option')
  assert.ok(!scene.columns.some((c) => c.name === 'type'))
  assert.deepEqual(scene.rows.map((r) => r.event), ['update', 'color'],
    'the color row folds to event:color; the set-cell on `type` retargets to `event`')

  const sliders = store.get('sliders')!
  assert.ok(sliders.columns.some((c) => c.name === 'name') && !sliders.columns.some((c) => c.name === 'id'))
  assert.deepEqual(sliders.rows.map((r) => r.name).sort(), ['depth', 'warp'],
    'the seeded row (renamed by set-cell) and the define-slider both fold into `name`')
})

test('column-naming migration: a rename-column referencing an old name is retargeted', () => {
  const legacy = JSON.stringify({
    version: 3, start: 1,
    events: [
      {
        kind: 'create', table: 'sliders',
        columns: [
          { name: 'id', type: 'string' }, { name: 'min', type: 'number' },
          { name: 'max', type: 'number' }, { name: 'default', type: 'number' },
        ],
        rows: [{ id: 'x', min: 0, max: 1, default: 0 }], seq: 0, t: 0, src: 'a',
      },
      // the user had renamed the (old) `id` column before the convention change
      { kind: 'rename-column', table: 'sliders', col: 'id', to: 'label', seq: 1, t: 0, src: 'a' },
    ],
  })
  const store = createEditableTableStore()
  assert.ok(store.load(legacy))
  const cols = store.get('sliders')!.columns.map((c) => c.name)
  assert.ok(cols.includes('label') && !cols.includes('id') && !cols.includes('name'),
    'the rename-column retargets from the migrated `name` column to `label`')
  assert.equal(store.get('sliders')!.rows[0].label, 'x')
})

test('load replaces the store entirely and notifies; clear empties it and notifies', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  let fired = 0
  store.onChange(() => fired++)

  const other = createEditableTableStore()
  other.createTable('only-in-other')
  assert.ok(store.load(other.serialize()))
  assert.ok(!store.has('t1'), 'previous state is gone, not merged')
  assert.ok(store.has('only-in-other'))
  assert.equal(fired, 1)

  store.clear()
  assert.ok(!store.has('only-in-other'))
  assert.equal(fired, 2)
})

test('load rejects garbage without touching existing state', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  assert.equal(store.load('not json'), false)
  assert.ok(store.has('t1'), 'existing state is untouched on a failed load')
})

test('onChange fires for appended events, not for rejected mutations', () => {
  const store = createEditableTableStore()
  let fired = 0
  store.onChange(() => fired++)
  store.createTable('t1')       // +1
  store.createTable('t1')       // duplicate — rejected
  store.addRow('t1')            // +1
  store.removeRow('t1', 99)     // out of range — rejected
  store.setCell('t1', 5, 'value', 1) // no such row — rejected
  assert.equal(fired, 2)
})

test('setRow atomically sets several cells as one event', () => {
  const store = createEditableTableStore()
  store.ensure('code', { code: 'code', seed: 'number' }, [{ code: 'a', seed: 1 }])
  store.setRow('code', 0, { code: 'b', seed: 2 })
  assert.deepEqual(store.get('code')!.rows, [{ code: 'b', seed: 2 }])
  const events = store.get('code')!.events
  assert.deepEqual(events.map((e) => e.kind), ['create', 'set-row'])
  assert.deepEqual(events[1].values, { code: 'b', seed: 2 })
})

test('schemaColumns: a string[] spec is enum shorthand; the object form is explicit', () => {
  const cols = schemaColumns({
    beat: 'number',
    event: ['setCode', 'layer'],
    mode: { type: 'enum', options: ['blend', 'add'], usedBy: ['layer'] },
    plain: { type: 'string' },
  })
  assert.deepEqual(cols, [
    { name: 'beat', type: 'number' },
    { name: 'event', type: 'enum', options: ['setCode', 'layer'] },
    { name: 'mode', type: 'enum', options: ['blend', 'add'], usedBy: ['layer'] },
    { name: 'plain', type: 'string' },
  ])
})

test('a code column language rides events, survives serialize/load, and tracks re-declaration', () => {
  const store = createEditableTableStore()
  store.ensure('sketches', { beat: 'number', code: { type: 'code', language: 'hydra' } })
  const col = () => store.get('sketches')!.columns.find((c) => c.name === 'code')!
  assert.equal(col().language, 'hydra')
  const store2 = createEditableTableStore()
  assert.ok(store2.load(store.serialize()))
  assert.equal(store2.get('sketches')!.columns.find((c) => c.name === 'code')!.language, 'hydra')
  store.ensure('sketches', { beat: 'number', code: 'code' })
  assert.equal(col().language, undefined)
})

test('renaming a declared column claims it whole — enum options and code language survive', () => {
  const store = createEditableTableStore()
  store.ensure('h', { event: ['setCode', 'layer'], code: { type: 'code', language: 'hydra' } })
  store.renameColumn('h', 'event', 'kind')
  store.renameColumn('h', 'code', 'sketch')
  const cols = store.get('h')!.columns
  assert.deepEqual(cols.find((c) => c.name === 'kind'), { name: 'kind', type: 'enum', options: ['setCode', 'layer'] })
  assert.deepEqual(cols.find((c) => c.name === 'sketch'), { name: 'sketch', type: 'code', language: 'hydra' })
})

test('an enum column defaults a new row to its first option', () => {
  const store = createEditableTableStore()
  store.ensure('h', { beat: 'number', event: ['setCode', 'layer'] })
  store.addRow('h')
  assert.deepEqual(store.get('h')!.rows, [{ beat: 1, event: 'setCode' }])
})

test('cellValid: blanks pass; a non-blank value must fit its type; enum must be in options', () => {
  const num: EditableColumn = { name: 'v', type: 'number' }
  const en: EditableColumn = { name: 'e', type: 'enum', options: ['a', 'b'] }
  // blank/unset is always allowed (these event tables are sparse)
  assert.equal(cellValid('', num), true)
  assert.equal(cellValid(null, en), true)
  assert.equal(cellValid(3, num), true)
  assert.equal(cellValid('3', num), false)
  assert.equal(cellValid(NaN, num), false)
  assert.equal(cellValid('a', en), true)
  assert.equal(cellValid('c', en), false)
  assert.equal(cellValid('anything', { name: 's', type: 'string' }), true)
})

test('"=" cells: valid in number columns; streaming results barred from timing columns', () => {
  const num: EditableColumn = { name: 'value', type: 'number' }
  assert.equal(cellValid("=slider('h').mul(2)", num), true)
  assert.equal(cellValid('=2 * 3', num), true)
  assert.equal(cellValid('=broken(', num), false)
  assert.equal(cellValid('=notAFn(1)', num), false)

  for (const name of ['beat', 'dur', 'loop']) {
    const col: EditableColumn = { name, type: 'number' }
    assert.equal(cellValid("=slider('h')", col), false, `a binding in ${name} would NaN the frame math`)
    assert.equal(cellValid('=lit(4).mul(2)', col), true, 'a constant expression is a plain number by cook time')
  }
})

test('cellValid: a plain string in `value` is valid for events that legitimately consume one there, not others', () => {
  const num: EditableColumn = { name: 'value', type: 'number' }
  assert.equal(cellValid('[80 120 80]', num, 'tile'), true)
  assert.equal(cellValid('[80 120 80]', num, 'radial'), false)
  assert.equal(cellValid('foo', num, 'replace'), true)
})

test('row rules: replace events and color pulses reject "=" values', () => {
  const cols: EditableColumn[] = [
    { name: 'event', type: 'enum', options: ['replace', 'setCode'] },
    { name: 'find', type: 'string' },
    { name: 'value', type: 'number' },
  ]
  assert.deepEqual(invalidColumns({ event: 'replace', find: 'a', value: '=lit(1)' }, cols), ['value'])
  assert.deepEqual(invalidColumns({ event: 'setCode', find: 'a', value: '=lit(1)' }, cols), [])

  const sceneCols: EditableColumn[] = [
    { name: 'color', type: 'number' },
    { name: 'dur', type: 'number' },
  ]
  assert.deepEqual(invalidColumns({ color: "=slider('c')", dur: 2 }, sceneCols), ['color'])
  assert.deepEqual(invalidColumns({ color: "=slider('c')" }, sceneCols), [])
})

test('setReplayView restores every table to its state at a past run', () => {
  const store = createEditableTableStore()
  store.ensure('code', { code: 'code' }, [{ code: 'v1' }])
  store.createTable('nums')
  store.addRow('nums')
  store.setCell('nums', 0, 'beat', 10)
  const run1 = store.recordRun()

  store.setRow('code', 0, { code: 'v2' })
  store.setCell('nums', 0, 'beat', 99)
  store.addRow('nums')
  store.recordRun()

  assert.equal(store.get('code')!.rows[0].code, 'v2')
  assert.deepEqual(store.get('nums')!.rows, [{ beat: 99 }, { beat: 1 }])

  store.setReplayView(run1)
  assert.equal(store.get('code')!.rows[0].code, 'v1')
  assert.deepEqual(store.get('nums')!.rows, [{ beat: 10 }])

  store.setReplayView(null)
  assert.equal(store.get('code')!.rows[0].code, 'v2')
  assert.deepEqual(store.get('nums')!.rows, [{ beat: 99 }, { beat: 1 }])
})

test('ensure is read-only while replaying — a scrubbed cook appends nothing', () => {
  const store = createEditableTableStore()
  store.ensure('code', { code: 'code' }, [{ code: 'a' }])
  const run = store.recordRun()
  const lenBefore = store.get('code')!.events.length

  store.setReplayView(run)
  // 'ghost' didn't exist at the replayed run: the seed comes back, the log stays put.
  assert.deepEqual(store.ensure('ghost', { v: 'number' }, [{ v: 5 }]), [{ v: 5 }])
  store.setReplayView(null)
  assert.ok(!store.has('ghost'), 'no create event leaked from the replay cook')
  assert.equal(store.get('code')!.events.length, lenBefore, 'code untouched')
})

test('an edit while replaying returns to head, never rewriting history', () => {
  const store = createEditableTableStore()
  store.createTable('nums')
  store.addRow('nums')
  store.setCell('nums', 0, 'beat', 1)
  const run1 = store.recordRun()
  store.setCell('nums', 0, 'beat', 2)
  store.recordRun()

  store.setReplayView(run1)
  assert.equal(store.get('nums')!.rows[0].beat, 1, 'viewing the past')
  store.setCell('nums', 0, 'beat', 3)
  assert.equal(store.get('nums')!.rows[0].beat, 3)
  assert.equal(store.runs().length, 2, 'no new run recorded by a plain edit')
})

test('deriveRunsFromCode reconstructs one run per recorded program Run (legacy sessions)', () => {
  const store = createEditableTableStore()
  store.ensure('code', { code: 'code' }, [{ code: 'r1' }]) // code Run 1 (create)
  store.createTable('nums')
  store.setRow('code', 0, { code: 'r2' })                  // code Run 2 (set-row)

  store.deriveRunsFromCode()
  const runs = store.runs()
  assert.equal(runs.length, 2, 'one run per code event')

  store.setReplayView(runs[0])
  assert.equal(store.get('code')!.rows[0].code, 'r1')
  assert.ok(!store.has('nums'), 'nums was created after Run 1')
  store.setReplayView(null)
  assert.equal(store.get('code')!.rows[0].code, 'r2')
})

test('deriveRunsFromCode stops at the latest clear-runs marker, leaving the code table untouched', () => {
  const store = createEditableTableStore()
  store.ensure('code', { code: 'code' }, [{ code: 'r1' }]) // code Run 1 (create)
  store.setRow('code', 0, { code: 'r2' })                  // code Run 2 (set-row)
  store.record('activity', CLEAR_RUNS_KIND)
  store.setRuns([])
  store.setRow('code', 0, { code: 'r3' })                  // code Run 3 (set-row), after the clear

  store.deriveRunsFromCode()
  const runs = store.runs()
  assert.equal(runs.length, 1, 'runs before the clear marker are not resurrected')

  assert.equal(store.get('code')!.rows[0].code, 'r3')
  assert.equal(store.get('code')!.events.length, 3, 'all three code events survive the clear')
})

test('load and clear reset the run list', () => {
  const store = createEditableTableStore()
  store.createTable('t')
  store.recordRun()
  assert.equal(store.runs().length, 1)

  const other = createEditableTableStore()
  other.createTable('x')
  assert.ok(store.load(other.serialize()))
  assert.equal(store.runs().length, 0, 'load resets runs')

  store.recordRun()
  store.clear()
  assert.equal(store.runs().length, 0, 'clear resets runs')
})

test('record() auto-creates a columnless table and appends the event to its history', () => {
  const store = createEditableTableStore()
  store.record('activity', 'apply')
  assert.ok(store.has('activity'))
  const t = store.get('activity')!
  assert.deepEqual(t.columns, [])
  assert.deepEqual(t.rows, [], 'not a row-editable table — just an event stream')
  assert.equal(t.events.length, 2)
  assert.equal(t.events[0].kind, 'create')
  assert.equal(t.events[1].kind, 'apply')

  store.record('activity', 'peer-join', { client: 'abc' })
  assert.equal(store.get('activity')!.events.length, 3)
  assert.equal(store.get('activity')!.events[2].client, 'abc')

  // Doesn't re-create (and so doesn't reset) an existing table.
  store.record('activity', 'apply')
  assert.equal(store.get('activity')!.events.length, 4)
})

test('record() rides the same log multiplayer syncs — merges in on another replica', () => {
  const a = createEditableTableStore({ src: 'a' })
  const b = createEditableTableStore({ src: 'b' })
  a.record('activity', 'apply')
  b.log.merge(a.log.all())
  assert.equal(b.get('activity')?.events.length, 2)
  assert.equal(b.get('activity')?.events[1].kind, 'apply')
})

test("an apply claims a peer's merged un-applied edit, so a later fold can't revert it", () => {
  const a = createEditableTableStore({ src: 'a' })
  const b = createEditableTableStore({ src: 'b' })
  a.createTable('t')
  a.addRow('t')
  a.addColumn('t', 'x', 'number')
  a.recordApply()
  b.log.merge(a.log.all())

  // B edits without applying; A merges that in and applies on top.
  b.setCell('t', 0, 'x', 7)
  a.log.merge(b.log.all())
  a.recordApply()
  b.log.merge(a.log.all())

  assert.equal(a.get('t')!.rows[0].x, 7, "A's apply carried the peer's edit")
  assert.equal(b.get('t')!.rows[0].x, 7, 'and B still reads its own value back')
})

test('recordApply commits the pending edits as an apply node and grows the branch path', () => {
  const store = createEditableTableStore()
  store.createTable('t')
  store.addRow('t')
  store.setCell('t', 0, 'beat', 1)
  const a1 = store.recordApply({ changed: ['t'] })!
  assert.equal(a1.parent, null, 'the first apply parents to the root')
  assert.equal(a1.fork, false)
  assert.equal(store.currentHead(), a1.id)

  store.setCell('t', 0, 'beat', 2)
  const a2 = store.recordApply()!
  assert.equal(a2.parent, a1.id, 'an ordinary apply extends the tip')
  assert.equal(a2.seen, a1.id)
  assert.equal(a2.fork, false)
  assert.deepEqual(store.branchPath().map((n) => n.id), [a1.id, a2.id])
})

test('hasPendingEdits gates on real table edits, not log-table markers', () => {
  const store = createEditableTableStore()
  assert.equal(store.hasPendingEdits(), false, 'nothing edited yet')

  store.createTable('t')
  store.addRow('t')
  store.setCell('t', 0, 'beat', 1)
  assert.equal(store.hasPendingEdits(), true, 'un-applied data edits are pending')

  store.recordApply()
  assert.equal(store.hasPendingEdits(), false, 'apply clears the pending edits')

  // A marker riding a log table (peer join, MIDI, loop resize) is not an edit.
  store.record(ACTIVITY_TABLE, 'set-loop-beats', { beats: 8 })
  assert.equal(store.hasPendingEdits(), false, 'log-table markers do not count')

  store.setCell('t', 0, 'beat', 2)
  assert.equal(store.hasPendingEdits(), true, 'a fresh data edit is pending again')
})

test('editing while scrubbed to an apply forks a new branch, leaving the old one intact', () => {
  const store = createEditableTableStore()
  store.createTable('t')
  store.addRow('t')
  store.setCell('t', 0, 'beat', 1)
  const a1 = store.recordApply()!
  store.setCell('t', 0, 'beat', 2)
  const a2 = store.recordApply()!

  store.setReplayView(a1.id)
  assert.equal(store.get('t')!.rows[0].beat, 1)

  store.setCell('t', 0, 'beat', 9)
  assert.equal(store.get('t')!.rows[0].beat, 9, 'edit hit the scrubbed state, not the head')

  const a3 = store.recordApply()!
  assert.equal(a3.parent, a1.id, 'the fork parents the scrubbed node')
  assert.equal(a3.seen, a2.id, 'seen records the tip forked away from')
  assert.equal(a3.fork, true)

  const tree = store.branchTree()
  assert.deepEqual(new Set(tree.heads), new Set([a2.id, a3.id]), 'two branches')
})

test('checkout switches the live fold to another branch and continues it', () => {
  const store = createEditableTableStore()
  store.createTable('t')
  store.addRow('t')
  store.setCell('t', 0, 'beat', 1)
  const a1 = store.recordApply()!
  store.setCell('t', 0, 'beat', 2)
  const a2 = store.recordApply()!
  store.setReplayView(a1.id)
  store.setCell('t', 0, 'beat', 9)
  const a3 = store.recordApply()!
  assert.equal(store.get('t')!.rows[0].beat, 9)

  store.checkout(a2.id)
  assert.equal(store.currentHead(), a2.id)
  assert.equal(store.get('t')!.rows[0].beat, 2, 'a2 branch restored')

  store.setCell('t', 0, 'beat', 3)
  const a4 = store.recordApply()!
  assert.equal(a4.parent, a2.id)
  assert.equal(a4.fork, false)
  assert.deepEqual(store.branchTree().heads.includes(a3.id), true, 'the fork stays a leaf')
})

test('un-applied edits overlay the live head only, not a scrubbed-back run', () => {
  const store = createEditableTableStore()
  store.createTable('t')
  store.addRow('t')
  store.setCell('t', 0, 'beat', 1)
  const a1 = store.recordApply()!
  store.setCell('t', 0, 'beat', 2)
  store.recordApply()
  store.setCell('t', 0, 'beat', 5)

  assert.equal(store.get('t')!.rows[0].beat, 5, 'pending edit shows at the live head')
  store.setReplayView(a1.id)
  assert.equal(store.get('t')!.rows[0].beat, 1, 'scrubbed back — pending edit hidden')
  store.setReplayView(null)
  assert.equal(store.get('t')!.rows[0].beat, 5, 'back at head — pending edit visible again')
})

test('serialize/load round-trips the branch tree and reopens on the latest branch', () => {
  const store = createEditableTableStore()
  store.createTable('t')
  store.addRow('t')
  store.setCell('t', 0, 'beat', 1)
  const a1 = store.recordApply()!
  store.setCell('t', 0, 'beat', 2)
  const a2 = store.recordApply()!
  store.setReplayView(a1.id)
  store.setCell('t', 0, 'beat', 9)
  const a3 = store.recordApply()!

  const reopened = createEditableTableStore()
  assert.ok(reopened.load(store.serialize()))
  assert.equal(reopened.currentHead(), a3.id, 'reopens on the newest apply')
  assert.deepEqual(new Set(reopened.branchTree().heads), new Set([a2.id, a3.id]))
  assert.equal(reopened.get('t')!.rows[0].beat, 9, 'a3 branch state restored')

  reopened.checkout(a2.id)
  assert.equal(reopened.get('t')!.rows[0].beat, 2)
})

test('a reload mid-edit reattaches the working tail so the next apply claims it', () => {
  const store = createEditableTableStore()
  store.createTable('t')
  store.addRow('t')
  store.setCell('t', 0, 'beat', 1)
  store.recordApply()
  store.setCell('t', 0, 'beat', 7)

  const reopened = createEditableTableStore()
  assert.ok(reopened.load(store.serialize()))
  assert.equal(reopened.get('t')!.rows[0].beat, 7, 'working tail overlays after reload')
  const a2 = reopened.recordApply()!
  assert.ok(a2.edits.length > 0, 'the next apply claims the reattached working tail')
  reopened.setReplayView(null)
  assert.equal(reopened.get('t')!.rows[0].beat, 7)
})

test('concurrent applies at the same tip linearize onto one branch across replicas', () => {
  const a = createEditableTableStore({ src: 'a' })
  const b = createEditableTableStore({ src: 'b' })
  a.createTable('t')
  a.addRow('t')
  const base = a.recordApply()!
  b.log.merge(a.log.all())
  b.checkout(base.id)

  a.setCell('t', 0, 'beat', 1)
  const aApply = a.recordApply()!
  b.setCell('t', 0, 'loop', 2)
  const bApply = b.recordApply()!
  assert.equal(aApply.seen, base.id)
  assert.equal(bApply.seen, base.id)

  a.log.merge(b.log.all())
  b.log.merge(a.log.all())
  assert.deepEqual(a.branchTree().heads, b.branchTree().heads)
  assert.equal(a.branchTree().heads.length, 1, 'the race resolves to one branch')
})

// ── defineSlider: code-declared slider rows ──────────────────────────────────

test('every declaration is logged; the fold keeps one row per name and the last range wins', () => {
  const store = createEditableTableStore()
  store.defineSlider('height', 0, 2)
  assert.deepEqual(
    store.get('sliders')!.rows.map((r) => ({ name: r.name, min: r.min, max: r.max, default: r.default })),
    [{ name: 'height', min: 0, max: 2, default: 0 }],
  )
  assert.equal(store.log.all().find((e) => e.kind === 'define-slider')!.src, 'slider:height')
  const len = store.log.length
  store.defineSlider('height', 0, 2) // rerun of the same code
  assert.equal(store.log.length, len + 1, 'the rerun is recorded — the log is what happened')
  assert.equal(store.get('sliders')!.rows.length, 1, 'still one slider')
  store.defineSlider('height', 0, 4) // the user changed the call's range
  const row = store.get('sliders')!.rows[0]
  assert.deepEqual({ min: row.min, max: row.max }, { min: 0, max: 4 }, 'last declaration wins')
  store.defineSlider('warp') // min/max default 0–1
  const warp = store.get('sliders')!.rows.find((r) => r.name === 'warp')!
  assert.deepEqual({ min: warp.min, max: warp.max }, { min: 0, max: 1 })
})

test('declarations from two replicas fold to one slider row after merge', () => {
  const a = createEditableTableStore({ src: 'A' })
  const b = createEditableTableStore({ src: 'B' })
  b.createTable('other') // offsets b's clock so the two declarations get distinct (src, seq) keys
  a.defineSlider('x', 0, 1)
  b.defineSlider('x', 0, 1)
  a.log.merge(b.log.all())
  b.log.merge(a.log.all())
  assert.equal(a.get('sliders')!.rows.length, 1)
  assert.equal(b.get('sliders')!.rows.length, 1)
})

test('a deleted slider row stays deleted until a later run declares it again', () => {
  const store = createEditableTableStore()
  store.defineSlider('x', 0, 1)
  store.removeRow('sliders', 0)
  const reopened = createEditableTableStore()
  assert.ok(reopened.load(store.serialize()))
  assert.equal(reopened.get('sliders')!.rows.length, 0, 'the removal folds after the declaration')
  reopened.defineSlider('x', 0, 1) // the program runs again — the code still declares it
  assert.equal(reopened.get('sliders')!.rows.length, 1)
})

// ── val() rows: post code cells materialize their variables ─────────────────

const POST_SCHEMA = {
  beat: 'number',
  event: ['setCode', 'add', 'remove', 'layer', 'transition', 'setVariable', 'pulse'],
  code: { type: 'code', language: 'post' },
  name: 'string',
  value: 'number',
} as const

test("a post cell's val() derives a setVariable row right after it, tracking the call across edits", () => {
  const store = createEditableTableStore()
  store.ensure('post', POST_SCHEMA, [{ beat: 2, event: 'setCode', code: 'bloom(val("glow", 0.5))' }])
  let rows = store.get('post')!.rows
  assert.equal(rows.length, 2)
  assert.deepEqual(
    { beat: rows[1].beat, event: rows[1].event, name: rows[1].name, value: rows[1].value },
    { beat: 2, event: 'setVariable', name: 'glow', value: 0.5 },
    'the derived setVariable row lands right after the cell, at its beat',
  )

  store.setCell('post', 0, 'code', 'bloom(val("glow", 0.9))')
  assert.equal(store.get('post')!.rows[1].value, 0.9, 'a pristine row tracks the declared value')

  store.setCell('post', 1, 'value', 0.7) // the user tweaks the materialized value
  store.setCell('post', 0, 'code', 'bloom(val("glow", 0.2)).blur(val("rad", 4))')
  rows = store.get('post')!.rows
  assert.equal(rows[1].value, 0.7, 'an edited value survives re-derivation')
  assert.deepEqual({ name: rows[2].name, value: rows[2].value }, { name: 'rad', value: 4 }, 'a new val() adds its row after')

  store.setCell('post', 0, 'code', 'blur(val("rad", 4))')
  rows = store.get('post')!.rows
  assert.deepEqual(rows.map((r) => r.name), ['', 'rad'], 'a removed val() deletes its row, even edited')
})

test('removing a post code row removes its val()-derived rows with it', () => {
  const store = createEditableTableStore()
  store.ensure('post', POST_SCHEMA, [
    { beat: 1, event: 'setCode', code: 'blur(val("rad", 4))' },
    { beat: 4, event: 'add', code: 'pixelate(val("px", 6))' },
  ])
  assert.equal(store.get('post')!.rows.length, 4)
  store.removeRow('post', 0)
  const rows = store.get('post')!.rows
  assert.equal(rows.length, 2, 'the cell and its derived row are both gone')
  assert.deepEqual(rows.map((r) => r.name), ['', 'px'])
})

// ── whole-table copy / replace ───────────────────────────────────────────────

test('serializeTable / replaceTable move a whole table — columns and rows — over another', () => {
  const store = createEditableTableStore()
  store.ensure('kf', { beat: 'number', v: 'number' }, [{ beat: 1, v: 10 }, { beat: 2, v: 20 }])
  store.createTable('t2')
  store.addRow('t2')

  assert.ok(store.replaceTable('t2', store.serializeTable('kf')!))
  assert.deepEqual(store.get('t2')!.columns, store.get('kf')!.columns)
  assert.deepEqual(store.get('t2')!.rows, [{ beat: 1, v: 10 }, { beat: 2, v: 20 }])

  // The pasted rows are the user's, and the seed slots they displaced stay
  // displaced — a re-seed can neither overwrite nor resurrect them.
  assert.ok(store.replaceTable('kf', store.serializeTable('t2')!.replace('10', '99')))
  assert.deepEqual(
    store.ensure('kf', { beat: 'number', v: 'number' }, [{ beat: 1, v: 11 }, { beat: 2, v: 22 }]),
    [{ beat: 1, v: 99 }, { beat: 2, v: 20 }],
  )
})

test('replaceTable takes a bare row array over the current columns, and refuses anything else', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  store.addColumn('t1', 'label', 'string')

  assert.ok(store.replaceTable('t1', [{ beat: 3, label: 'a' }, { beat: 4 }]))
  assert.deepEqual(store.get('t1')!.rows, [{ beat: 3, label: 'a' }, { beat: 4, label: '' }])

  const before = store.serialize()
  for (const junk of ['not json', '{"rows":7}', '[3]', JSON.stringify({ rows: [{}], columns: [] })]) {
    assert.ok(!store.replaceTable('t1', junk), `refuses ${junk}`)
  }
  assert.ok(!store.replaceTable('nope', []), 'refuses an unknown table')
  assert.equal(store.serialize(), before, 'a refused paste never touches the log')
})

test('copying a post table leaves its val()-derived rows out, so replacing re-derives them once', () => {
  const store = createEditableTableStore()
  store.ensure('post', POST_SCHEMA, [{ beat: 2, event: 'setCode', code: 'bloom(val("glow", 0.5))' }])
  assert.ok(store.replaceTable('post', store.serializeTable('post')!))
  assert.deepEqual(store.get('post')!.rows.map((r) => r.name), ['', 'glow'])
})
