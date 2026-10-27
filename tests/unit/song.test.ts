import { describe, expect, it } from 'vite-plus/test'
import { fitRange } from '../../engine/render/keyboard-layout'
import { handFor, handFromName, resolveHandSplit } from '../../engine/song/hand-split'
import { playability, separateHands } from '../../engine/song/hand-separation'
import { buildMeasures, measureAtTime } from '../../engine/song/measures'
import { parseSong } from '../../engine/song/parse'
import { TempoMap } from '../../engine/song/tempo-map'
import type { HandSplit, TrackInfo } from '../../engine/types'
import { minuet, tempoChanges, twinkle } from '../fixtures/midis'

describe('TempoMap', () => {
  const map = new TempoMap(480, [
    { ticks: 0, bpm: 120 },
    { ticks: 1920, bpm: 60 },
  ])

  it('converts ticks to seconds across tempo changes', () => {
    expect(map.ticksToSeconds(0)).toBe(0)
    expect(map.ticksToSeconds(480)).toBeCloseTo(0.5)
    expect(map.ticksToSeconds(1920)).toBeCloseTo(2)
    expect(map.ticksToSeconds(2400)).toBeCloseTo(3)
  })

  it('round-trips seconds to ticks', () => {
    for (const tick of [0, 100, 1919, 1920, 5000]) {
      expect(map.secondsToTicks(map.ticksToSeconds(tick))).toBeCloseTo(tick)
    }
  })

  it('defaults to 120 bpm and reports tempo', () => {
    const plain = new TempoMap(96, [])
    expect(plain.ticksToSeconds(96)).toBeCloseTo(0.5)
    expect(map.bpmAt(2000)).toBeCloseTo(60)
  })

  it('lets a later tempo at the same tick win', () => {
    const dup = new TempoMap(480, [
      { ticks: 0, bpm: 120 },
      { ticks: 0, bpm: 60 },
    ])
    expect(dup.ticksToSeconds(480)).toBeCloseTo(1)
  })
})

describe('measures', () => {
  it('follows time signature changes', () => {
    const map = new TempoMap(480, [{ ticks: 0, bpm: 60 }])
    const measures = buildMeasures(
      map,
      [
        { ticks: 0, numerator: 4, denominator: 4 },
        { ticks: 3840, numerator: 3, denominator: 4 },
      ],
      3840 + 1440 * 2,
    )
    expect(measures.map((m) => m.endTick - m.startTick)).toEqual([1920, 1920, 1440, 1440])
    expect(measures[2]!.startSec).toBeCloseTo(8)
    expect(measureAtTime(measures, 8.5)).toBe(2)
    expect(measureAtTime(measures, 0)).toBe(0)
  })
})

describe('hand split', () => {
  const track = (index: number, meanPitch: number, noteCount = 10): TrackInfo => ({
    index,
    name: '',
    noteCount,
    meanPitch,
  })

  it('maps two tracks to hands by register', () => {
    const split = resolveHandSplit([track(0, 72), track(1, 48)])
    expect(split).toEqual({ mode: 'tracks', trackMap: { 0: 'R', 1: 'L' } })
  })

  it('ignores empty tracks when counting', () => {
    const split = resolveHandSplit([track(0, 0, 0), track(1, 72), track(2, 50)])
    expect(split.mode).toBe('tracks')
    expect(split.trackMap).toEqual({ 1: 'R', 2: 'L' })
  })

  it('works hands out from the notes when the tracks do not tell', () => {
    expect(resolveHandSplit([track(0, 60)])).toEqual({ mode: 'smart' })
    expect(resolveHandSplit([track(0, 72), track(1, 60), track(2, 48)]).mode).toBe('smart')
    const split: HandSplit = { mode: 'pitch', splitPitch: 60 }
    expect(handFor({ pitch: 59, track: 0 }, split)).toBe('L')
    expect(handFor({ pitch: 60, track: 0 }, split)).toBe('R')
  })

  it('reads hands from track names, also with more than two tracks', () => {
    const named = (index: number, name: string, meanPitch: number) => ({
      ...track(index, meanPitch),
      name,
    })
    const split = resolveHandSplit([
      named(0, 'Piano right first', 65),
      named(1, 'PIano right second', 62),
      named(2, 'Piano left', 41),
    ])
    expect(split).toEqual({ mode: 'tracks', trackMap: { 0: 'R', 1: 'R', 2: 'L' } })
    expect(handFromName('Upright piano')).toBe(null)
    expect(handFromName('Bass and treble')).toBe(null)
    expect(handFromName('LH')).toBe('L')
    expect(handFromName('Treble')).toBe('R')
  })

  it('honours user overrides', () => {
    const tracks = [track(0, 72), track(1, 48)]
    expect(resolveHandSplit(tracks, { mode: 'pitch', splitPitch: 55 })).toEqual({
      mode: 'pitch',
      splitPitch: 55,
    })
    const swapped = resolveHandSplit(tracks, { mode: 'tracks', trackMap: { 0: 'L', 1: 'R' } })
    expect(handFor({ pitch: 80, track: 0 }, swapped)).toBe('L')
  })
})

describe('parseSong', () => {
  it('works out hands for a single-track file', () => {
    const song = parseSong(twinkle())
    expect(song.title).toBe('Twinkle, Twinkle')
    expect(song.handSplit.mode).toBe('smart')
    expect(song.notes.filter((n) => n.hand === 'R')).toHaveLength(14)
    expect(song.notes.every((n) => n.pitch < 60 === (n.hand === 'L'))).toBe(true)
    expect(song.measures).toHaveLength(4)
    expect(song.durationSec).toBeCloseTo(8, 1)
  })

  it('honours per-note fixes and re-solves around them in smart mode', () => {
    const plain = parseSong(twinkle())
    const target = plain.notes.find((n) => n.hand === 'R')!
    const fixed = parseSong(twinkle(), {
      handSplit: { mode: 'smart', fixes: { [target.id]: 'L' } },
    })
    expect(fixed.notes.find((n) => n.id === target.id)!.hand).toBe('L')
    const byPitch = parseSong(twinkle(), {
      handSplit: { mode: 'pitch', splitPitch: 60, fixes: { [target.id]: 'L' } },
    })
    expect(byPitch.notes.find((n) => n.id === target.id)!.hand).toBe('L')
    expect(byPitch.notes.filter((n) => n.hand === 'L')).toHaveLength(
      plain.notes.filter((n) => n.hand === 'L').length + 1,
    )
  })

  it('maps two tracks to hands and uses 3/4 bars', () => {
    const song = parseSong(minuet())
    expect(song.handSplit.mode).toBe('tracks')
    expect(song.notes.filter((n) => n.track === 0).every((n) => n.hand === 'R')).toBe(true)
    expect(song.notes.filter((n) => n.track === 1).every((n) => n.hand === 'L')).toBe(true)
    expect(song.measures).toHaveLength(8)
    expect(song.measures[0]!.numerator).toBe(3)
  })

  it('places notes using the tempo map', () => {
    const song = parseSong(tempoChanges())
    const starts = song.notes.filter((n) => n.track === 0).map((n) => n.startSec)
    expect(starts[1]).toBeCloseTo(0.6)
    expect(starts[9]! - starts[8]!).toBeCloseTo(60 / 140)
    const chord = song.notes.filter((n) => n.startTick === 16 * 480)
    expect(chord).toHaveLength(3)
    expect(chord[0]!.measure).toBe(4)
    expect(song.measures[4]!.numerator).toBe(3)
  })

  it('sorts notes by time and gives them stable ids', () => {
    const a = parseSong(minuet())
    const b = parseSong(minuet())
    expect(a.notes.map((n) => n.id)).toEqual(b.notes.map((n) => n.id))
    for (let i = 1; i < a.notes.length; i++) {
      expect(a.notes[i]!.startSec).toBeGreaterThanOrEqual(a.notes[i - 1]!.startSec)
    }
  })
})

describe('fitRange', () => {
  it('pads to whole octaves and at least two of them', () => {
    expect(fitRange([60, 64, 67])).toEqual([48, 71])
    expect(fitRange([43, 79])).toEqual([36, 83])
    expect(fitRange([21, 108])).toEqual([21, 108])
    expect(fitRange([])).toEqual([21, 108])
  })
})

describe('separateHands', () => {
  const note = (pitch: number, startSec: number, dur = 0.4) => ({
    pitch,
    startSec,
    endSec: startSec + dur,
  })

  it('keeps an arpeggio that crosses middle C in one hand', () => {
    // Moonlight-style triplets G#3–C#4–E4 over a low bass octave.
    const notes = [note(37, 0, 2), note(49, 0, 2)]
    for (let i = 0; i < 12; i++) notes.push(note([56, 61, 64][i % 3]!, i / 3, 0.3))
    const hands = separateHands(notes)
    expect(hands.slice(0, 2)).toEqual(['L', 'L'])
    expect(new Set(hands.slice(2))).toEqual(new Set(['R']))
  })

  it('never gives one hand a chord wider than a tenth', () => {
    const notes = [note(40, 0), note(52, 0), note(64, 0), note(76, 0)]
    const hands = separateHands(notes)
    expect(playability(notes, hands)).toEqual({ spans: 0, crowded: 0, leaps: 0 })
  })

  it('respects fixed notes', () => {
    const notes = [note(50, 0), note(70, 0.5)]
    expect(separateHands(notes, { fixed: new Map([[0, 'R']]) })[0]).toBe('R')
  })
})
