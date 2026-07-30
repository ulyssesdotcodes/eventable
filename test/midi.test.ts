import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeMidi, midiRow,
  buildMidiIndex, sampleMidiAt, createMidiInput,
} from '../src/midi.js'
import { buildTimeline } from '../src/timeline.js'
import { frameToBeat, beatToFrame } from '../src/constants.js'
import type { Row } from '../src/lineage.js'
import type { LogStore, StampedEvent } from '../src/event-log.js'

const b = (frame: number): number => frameToBeat(frame)

// In-memory stand-in for the editable-table store the app backs MIDI with.
function fakeStore(): LogStore {
  const events: StampedEvent[] = []
  let seq = 0
  const listeners: (() => void)[] = []
  return {
    record(kind: string, payload: Record<string, unknown> = {}): void {
      events.push({ kind, table: 'midi', seq: seq++, t: 0, ...payload })
      listeners.forEach((f) => f())
    },
    events: () => events.slice(),
    onChange: (cb: () => void) => { listeners.push(cb) },
  }
}

test('decodeMidi reads note-on / note-off / CC and channels', () => {
  assert.deepEqual(decodeMidi([0x90, 60, 127]), { note: 'c4', noteNum: 60, channel: 1, value: 1 })
  assert.deepEqual(decodeMidi([0x80, 60, 0]), { note: 'c4', noteNum: 60, channel: 1, value: 0 })
  // note-on with velocity 0 is a note-off
  assert.equal(decodeMidi([0x90, 60, 0])!.value, 0)
  // channel is 1-based: 0x95 → channel 6
  assert.equal(decodeMidi([0x95, 64, 64])!.channel, 6)
  assert.deepEqual(decodeMidi([0xb0, 1, 64]), { note: 'cc1', noteNum: 1, channel: 1, value: 64 / 127 })
  // unhandled status (pitch bend) → null
  assert.equal(decodeMidi([0xe0, 0, 64]), null)
})

test('sampleMidiAt returns the most recent value at-or-before the frame', () => {
  // c4 played (value 1) at frame 60; released (value 0) at frame 120
  const rows: Row[] = [
    midiRow(decodeMidi([0x90, 60, 127])!, b(60)),
    midiRow(decodeMidi([0x80, 60, 0])!, b(120)),
  ]
  const idx = buildMidiIndex(rows)
  assert.equal(sampleMidiAt(idx, 'c4', null, 59), 0, 'before the note: silent')
  assert.equal(sampleMidiAt(idx, 'c4', null, 60), 1, 'at the note frame: on')
  assert.equal(sampleMidiAt(idx, 'c4', null, 119), 1, 'still held')
  assert.equal(sampleMidiAt(idx, 'c4', null, 120), 0, 'after release: off')
  assert.equal(sampleMidiAt(idx, 'd4', null, 999), 0, 'unknown note: 0')
})

test('sampleMidiAt filters by channel when one is given', () => {
  const rows: Row[] = [
    midiRow(decodeMidi([0x90, 60, 127])!, 1),  // c4 ch1 value 1
    midiRow(decodeMidi([0x91, 60, 64])!, 2),   // c4 ch2 value ~0.5
  ]
  const idx = buildMidiIndex(rows)
  assert.equal(sampleMidiAt(idx, 'c4', null, 999), 64 / 127, 'any channel → most recent overall')
  assert.equal(sampleMidiAt(idx, 'c4', 1, 999), 1, 'channel 1 only')
  assert.equal(sampleMidiAt(idx, 'c4', 2, 999), 64 / 127, 'channel 2 only')
  assert.equal(sampleMidiAt(idx, 'c4', 3, 999), 0, 'channel with no events')
})

test('createMidiInput stamps events with the current source position', () => {
  let srcBeat = 1
  const input = createMidiInput({ store: fakeStore(), getIndex: () => srcBeat })

  srcBeat = b(60)
  input.feed([0x90, 60, 127]) // c4 on
  srcBeat = b(300)            // playhead moved on, but the event keeps its stamp

  const rows = input.rows()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].note, 'c4')
  assert.equal(rows[0].beat, b(60), 'stamped at the source position it was heard at')

  assert.equal(input.ctxAt(60)!.midi!('c4', null), 1)
  assert.equal(input.ctxAt(59)!.midi!('c4', null), 0)
})

test('ignored messages record nothing; clear() empties the fold', () => {
  const input = createMidiInput({ store: fakeStore(), getIndex: () => 1 })
  input.feed([0x90, 62, 100])
  input.feed([0xe0, 0, 0]) // ignored message → no event
  assert.equal(input.rows().length, 1)
  input.clear()
  assert.equal(input.rows().length, 0)
})

test('a note played in a new loop replaces its previous take; untouched notes carry forward', () => {
  let src = 1, loop = 0
  const input = createMidiInput({ store: fakeStore(), getIndex: () => src, getLoop: () => loop })

  src = 2; input.feed([0x90, 60, 127]) // c4 on
  src = 3; input.feed([0x90, 62, 100]) // d4 on

  loop = 1
  src = 1.5; input.feed([0x90, 60, 64]) // c4 on again, new position

  const rows = input.rows()
  const c4rows = rows.filter((r) => r.note === 'c4')
  const d4rows = rows.filter((r) => r.note === 'd4')

  assert.equal(c4rows.length, 1, 'old c4 take folded away; only the new one is current')
  assert.equal(c4rows[0].beat, 1.5, 'new c4 is at beat 1.5, not beat 2')
  assert.equal(c4rows[0].value, 64 / 127)
  assert.equal(d4rows.length, 1, 'd4 was not played in loop 1 — it carries forward')

  const logged = input.eventRows().filter((r) => r.note === 'c4')
  assert.equal(logged.length, 2, 'both c4 events remain in the log')
  assert.deepEqual(logged.map((r) => r.loop), [0, 1])
})

test('a second play of the same note in the same loop adds to that take', () => {
  let src = 1, loop = 0
  const input = createMidiInput({ store: fakeStore(), getIndex: () => src, getLoop: () => loop })

  src = 2; input.feed([0x90, 60, 127]) // c4 on

  loop = 1
  src = 1.5; input.feed([0x90, 60, 100])
  src = 2.5; input.feed([0x90, 60, 50])

  const c4rows = input.rows().filter((r) => r.note === 'c4')
  assert.equal(c4rows.length, 2, 'both loop-1 events kept')
  assert.deepEqual(c4rows.map((r) => r.beat), [1.5, 2.5])
})

test('a burst of messages at the same frame replaces rather than piling up', () => {
  let src = 2
  const input = createMidiInput({ store: fakeStore(), getIndex: () => src })

  input.feed([0x90, 60, 10])
  input.feed([0x90, 60, 64])
  input.feed([0x90, 60, 127])

  const c4rows = input.rows().filter((r) => r.note === 'c4')
  assert.equal(c4rows.length, 1, 'only the latest value at this beat survives')
  assert.equal(c4rows[0].value, 1, 'last write wins')
})

test('same note/beat but different channels keep one row per channel', () => {
  let src = 2
  const input = createMidiInput({ store: fakeStore(), getIndex: () => src })

  input.feed([0x90, 60, 100]) // c4, channel 1
  input.feed([0x91, 60, 50])  // c4, channel 2, same beat

  const c4rows = input.rows().filter((r) => r.note === 'c4')
  assert.equal(c4rows.length, 2, 'distinct channels are not deduped against each other')
  assert.deepEqual(c4rows.map((r) => r.channel).sort(), [1, 2])
})

// MIDI is recorded at the playhead's content/source position (see
// Playback.currentSourceBeats), not wall-clock time — so remapping the
// timeline stretches recorded sweeps along with everything else on screen.

test('a sweep recorded under an identity mapping takes 2x as long once the timeline is remapped 2x slower', () => {
  const events: Row[] = [
    { type: 'midi', note: 'c4', channel: 1, value: 1, beat: 1 },
    { type: 'midi', note: 'c4', channel: 1, value: 0, beat: 3 },
  ]
  const index = buildMidiIndex(events)

  // 2x slower: playback beats 1..9 sweep source beats 1..5.
  const slow = buildTimeline([{ beat: 1, source: 1 }, { beat: 9, source: 5 }])
  const valueAtBeat = (playbackBeat: number): number =>
    sampleMidiAt(index, 'c4', 1, beatToFrame(slow.sourceBeatAt(playbackBeat)))

  assert.equal(valueAtBeat(1), 1, 'on at playback beat 1 (source beat 1)')
  assert.equal(valueAtBeat(3), 1, 'still on at beat 3 (source only reached beat 2)')
  assert.equal(valueAtBeat(4.9), 1, 'still on just before source reaches beat 3')
  assert.equal(valueAtBeat(5), 0, 'off at beat 5 — the sweep took 4 playback beats, not 2')
})
