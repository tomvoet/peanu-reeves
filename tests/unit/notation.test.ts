import { describe, expect, it } from 'vite-plus/test'
import { keyAlter, layoutNotation, spell, tickAt } from '../../engine/song/notation'
import { parseSong } from '../../engine/song/parse'
import type { Song, SongNote } from '../../engine/types'
import { minuet } from '../fixtures/midis'

const PPQ = 480

function song(notes: [pitch: number, beat: number, beats: number][], keyFifths?: number): Song {
  const measures = [0, 1].map((index) => ({
    index,
    startTick: index * 4 * PPQ,
    endTick: (index + 1) * 4 * PPQ,
    startSec: index * 2,
    endSec: (index + 1) * 2,
    numerator: 4,
    denominator: 4,
  }))
  return {
    title: 't',
    ppq: PPQ,
    durationSec: 4,
    measures,
    tracks: [],
    handSplit: { mode: 'tracks' },
    keyFifths,
    notes: notes.map(([pitch, beat, beats], i): SongNote => ({
      id: String(i),
      pitch,
      startTick: beat * PPQ,
      endTick: (beat + beats) * PPQ,
      startSec: beat / 2,
      endSec: (beat + beats) / 2,
      velocity: 80,
      hand: pitch >= 60 ? 'R' : 'L',
      measure: Math.floor(beat / 4),
      track: 0,
    })),
  }
}

describe('notation', () => {
  it('spells black keys by the key signature', () => {
    expect(spell(66, 1)).toEqual({ pos: 31, alter: 1 })
    expect(spell(70, -2)).toEqual({ pos: 34, alter: -1 })
    expect(spell(60, 0)).toEqual({ pos: 28, alter: 0 })
    expect(keyAlter(3, 1)).toBe(1)
    expect(keyAlter(2, -2)).toBe(-1)
    expect(keyAlter(5, -2)).toBe(0)
  })

  it('prints accidentals once per bar and naturals that cancel them', () => {
    const n = layoutNotation(
      song(
        [
          [66, 0, 1],
          [66, 1, 1],
          [65, 2, 1],
          [66, 4, 1],
        ],
        0,
      ),
    )
    expect(n.chords.map((c) => c.heads[0]!.accidental)).toEqual([1, null, 0, 1])
  })

  it('leaves notes the key signature covers alone', () => {
    const n = layoutNotation(
      song(
        [
          [70, 0, 1],
          [71, 1, 1],
        ],
        -1,
      ),
    )
    expect(n.chords.map((c) => c.heads[0]!.accidental)).toEqual([null, 0])
  })

  it('writes lengths, beams eighths by beat and flips seconds', () => {
    const n = layoutNotation(
      song(
        [
          [72, 0, 0.5],
          [74, 0.5, 0.5],
          [76, 1, 1.5],
          [64, 2.5, 0.5],
          [65, 3, 1],
          [67, 3, 1],
          [48, 0, 4],
        ],
        0,
      ),
    )
    const treble = n.chords.filter((c) => c.clef === 'treble')
    expect(treble.map((c) => c.beats)).toEqual([0.5, 0.5, 1.5, 0.5, 1])
    expect(n.beams).toHaveLength(1)
    expect(n.beams[0]!.map((c) => c.tick)).toEqual([0, 240])
    expect(treble.at(-1)!.heads.map((h) => h.flipped)).toEqual([false, true])
    expect(n.chords.find((c) => c.clef === 'bass')!.beats).toBe(4)
  })

  it('guesses the key when the file has none', () => {
    expect(layoutNotation(parseSong(minuet())).fifths).toBe(1)
  })

  it('maps seconds to ticks within bars', () => {
    const s = song([], 0)
    expect(tickAt(s.measures, 1)).toBe(2 * PPQ)
    expect(tickAt(s.measures, 3)).toBe(6 * PPQ)
  })
})
