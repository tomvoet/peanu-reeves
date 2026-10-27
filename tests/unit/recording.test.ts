import { describe, expect, it } from 'vite-plus/test'
import tonejs from '@tonejs/midi'
import { eventsToMidi } from '../../engine/recording/export'
import { guessKey } from '../../engine/recording/key'
import {
  alignTake,
  notesOf,
  pedalDown,
  sliceEvents,
  trimBuffer,
  type TakeEvent,
} from '../../engine/recording/take'
import type { SongNote } from '../../engine/types'

const on = (t: number, pitch: number, velocity = 80): TakeEvent => ({
  kind: 'on',
  t,
  pitch,
  velocity,
})
const off = (t: number, pitch: number): TakeEvent => ({ kind: 'off', t, pitch })
const pedal = (t: number, value: number): TakeEvent => ({ kind: 'pedal', t, cc: 64, value })

describe('notesOf', () => {
  it('pairs notes and extends their sound while the pedal is down', () => {
    const { notes, pedal: down } = notesOf([
      on(0, 60),
      pedal(0.2, 127),
      off(0.5, 60),
      pedal(1, 0),
      on(1.2, 62),
    ])
    expect(down).toEqual([[0.2, 1]])
    expect(notes[0]).toMatchObject({ pitch: 60, start: 0, end: 0.5, soundEnd: 1 })
    expect(notes[1]).toMatchObject({ pitch: 62, start: 1.2 })
    expect(pedalDown(down, 0.6)).toBe(true)
    expect(pedalDown(down, 1.1)).toBe(false)
  })
})

describe('alignTake', () => {
  const score: SongNote[] = [
    {
      id: 'a',
      pitch: 48,
      startTick: 0,
      endTick: 1,
      startSec: 0,
      endSec: 1,
      velocity: 80,
      hand: 'L',
      measure: 0,
      track: 0,
    },
    {
      id: 'b',
      pitch: 72,
      startTick: 0,
      endTick: 1,
      startSec: 1,
      endSec: 1.5,
      velocity: 80,
      hand: 'R',
      measure: 0,
      track: 0,
    },
  ]

  it('takes the hand of the matched score note and measures timing in real ms', () => {
    const aligned = alignTake(
      notesOf([on(0.02, 48), off(1, 48), on(0.95, 72), off(1.4, 72)]).notes,
      score,
      0.5,
    )
    expect(aligned.map((n) => [n.hand, n.ref?.id, Math.round(n.deviationMs ?? 0)])).toEqual([
      ['L', 'a', 40],
      ['R', 'b', -100],
    ])
  })

  it('leaves wrong notes unmatched', () => {
    const [n] = alignTake(notesOf([on(0, 61), off(0.5, 61)]).notes, score, 1)
    expect(n?.ref).toBeNull()
  })
})

describe('event buffers', () => {
  it('keeps only the recent window and closes notes cut by a slice', () => {
    const events = [on(0, 60), off(1, 60), on(5, 62), on(9, 64), off(10, 64)]
    expect(trimBuffer(events, 10, 6)).toEqual(events.slice(2))
    expect(sliceEvents(events, 4, 9.5)).toEqual([on(5, 62), on(9, 64), off(9.5, 62), off(9.5, 64)])
  })
})

describe('guessKey', () => {
  it('recognises a D minor arpeggio', () => {
    const events: TakeEvent[] = []
    const dMinor = [50, 53, 57, 62, 65, 69, 74, 69, 65, 62, 57, 53, 50, 61, 57, 50]
    dMinor.forEach((p, i) => events.push(on(i * 0.25, p), off(i * 0.25 + 0.24, p)))
    expect(guessKey(notesOf(events).notes)).toMatchObject({ tonic: 'D', mode: 'minor' })
  })
})

describe('eventsToMidi', () => {
  it('writes notes, velocity and pedal in real time', () => {
    const bytes = eventsToMidi([on(10, 60, 100), pedal(10.5, 127), off(11, 60), pedal(12, 0)], {
      name: 'Idea',
      timeScale: 0.5,
    })
    const midi = new tonejs.Midi(bytes)
    const [note] = midi.tracks[0]!.notes
    expect(note?.midi).toBe(60)
    expect(note?.time).toBeCloseTo(0, 2)
    expect(note?.duration).toBeCloseTo(2, 2)
    expect(Math.round((note?.velocity ?? 0) * 127)).toBe(100)
    expect(midi.tracks[0]!.controlChanges[64]?.length).toBe(2)
  })
})
