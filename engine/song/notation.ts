import { guessKey, keyFifths } from '../recording/key'
import type { Measure, Song, SongNote } from '../types'

export type Clef = 'treble' | 'bass'
/** −1 flat, 0 natural, 1 sharp. */
export type Alter = -1 | 0 | 1

export interface Head {
  note: SongNote
  /** Diatonic steps above C0 (C4 is 28). */
  pos: number
  /** Accidental to print, or null when the key or an earlier one in the bar already says it. */
  accidental: Alter | null
  /** Drawn on the other side of the stem, next to a neighbour one step away. */
  flipped: boolean
}

export interface Chord {
  clef: Clef
  tick: number
  measure: number
  /** Written length in quarter notes, e.g. 1.5 for a dotted quarter. */
  beats: number
  /** Lowest first. */
  heads: Head[]
  stemUp: boolean
  beamed: boolean
}

export interface Notation {
  fifths: number
  ppq: number
  /** By tick. */
  chords: Chord[]
  /** Chords sharing a beam, left to right. */
  beams: Chord[][]
}

/** Middle staff line: B4 in the treble clef, D3 in the bass clef. */
export const MIDDLE_LINE: Record<Clef, number> = { treble: 34, bass: 22 }

/** Written lengths in quarter notes, from whole to sixteenth. */
const WRITTEN = [4, 3, 2, 1.5, 1, 0.75, 0.5, 0.25] as const
/** Letter (C = 0 … B = 6) and alteration per pitch class. */
const SHARP_SPELLING = [
  [0, 0],
  [0, 1],
  [1, 0],
  [1, 1],
  [2, 0],
  [3, 0],
  [3, 1],
  [4, 0],
  [4, 1],
  [5, 0],
  [5, 1],
  [6, 0],
] as const satisfies readonly (readonly [number, Alter])[]
const FLAT_SPELLING = [
  [0, 0],
  [1, -1],
  [1, 0],
  [2, -1],
  [2, 0],
  [3, 0],
  [4, -1],
  [4, 0],
  [5, -1],
  [5, 0],
  [6, -1],
  [6, 0],
] as const satisfies readonly (readonly [number, Alter])[]
/** Letters in the order the key signature adds them. */
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6] as const
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3] as const

export function spell(pitch: number, fifths: number): { pos: number; alter: Alter } {
  const pc = pitch % 12
  const octave = Math.floor(pitch / 12) - 1
  // Keys with six sharps or flats write E♯ and C♭ instead of F and B.
  if (fifths >= 6 && pc === 5) return { pos: octave * 7 + 2, alter: 1 }
  if (fifths <= -6 && pc === 11) return { pos: (octave + 1) * 7, alter: -1 }
  const [letter, alter] = (fifths < 0 ? FLAT_SPELLING : SHARP_SPELLING)[pc]!
  return { pos: octave * 7 + letter, alter }
}

export function keyAlter(letter: number, fifths: number): Alter {
  if (fifths > 0) return SHARP_ORDER.indexOf(letter as never) < fifths ? 1 : 0
  if (fifths < 0) return FLAT_ORDER.indexOf(letter as never) < -fifths ? -1 : 0
  return 0
}

const letterOf = (pos: number): number => ((pos % 7) + 7) % 7

function nearestWritten(beats: number): number {
  let best: number = WRITTEN[0]
  for (const w of WRITTEN)
    if (Math.abs(Math.log(w / beats)) < Math.abs(Math.log(best / beats))) best = w
  return best
}

/** The file's key signature, or one worked out from the notes when the file says C or nothing. */
function fifthsOf(song: Song): number {
  if (song.keyFifths) return song.keyFifths
  const guess = guessKey(
    song.notes.map((n) => ({ pitch: n.pitch, start: n.startSec, soundEnd: n.endSec })),
  )
  return guess && guess.confidence >= 0.6 ? keyFifths(guess) : (song.keyFifths ?? 0)
}

/** Beats are beamed together. Compound metres beam in dotted quarters. */
function beamTicks(m: Measure, ppq: number): number {
  return m.denominator === 8 && m.numerator % 3 === 0 && m.numerator > 3
    ? ppq * 1.5
    : (ppq * 4) / m.denominator
}

/** Lays a song out on a grand staff: right hand on treble, left hand on bass. */
export function layoutNotation(song: Song): Notation {
  const fifths = fifthsOf(song)
  const grid = Math.max(1, song.ppq / 4)
  const snap = (t: number) => Math.round(t / grid) * grid
  const chords: Chord[] = []
  const beams: Chord[][] = []

  for (const clef of ['treble', 'bass'] as const) {
    const hand = clef === 'treble' ? 'R' : 'L'
    const byTick = new Map<number, SongNote[]>()
    for (const n of song.notes) {
      if (n.hand !== hand) continue
      const t = snap(n.startTick)
      byTick.set(t, [...(byTick.get(t) ?? []), n])
    }

    const ticks = [...byTick.keys()].toSorted((a, b) => a - b)
    const own: Chord[] = []
    let measure = -1
    let state = new Map<number, Alter>()

    ticks.forEach((tick, i) => {
      const notes = byTick.get(tick)!.toSorted((a, b) => a.pitch - b.pitch)
      const held = Math.max(...notes.map((n) => Math.max(grid, snap(n.endTick) - tick)))
      const next = ticks[i + 1]
      const beats = nearestWritten(
        Math.min(held, next === undefined ? held : next - tick) / song.ppq,
      )

      const m = notes[0]!.measure
      if (m !== measure) {
        measure = m
        state = new Map()
      }

      const heads: Head[] = []
      for (const note of notes) {
        const { pos, alter } = spell(note.pitch, fifths)
        if (heads.some((h) => h.pos === pos)) continue
        const current = state.get(pos) ?? keyAlter(letterOf(pos), fifths)
        state.set(pos, alter)
        heads.push({ note, pos, accidental: alter === current ? null : alter, flipped: false })
      }

      const mean = heads.reduce((s, h) => s + h.pos, 0) / heads.length
      own.push({
        clef,
        tick,
        measure: m,
        beats,
        heads,
        stemUp: mean < MIDDLE_LINE[clef],
        beamed: false,
      })
    })

    let group: Chord[] = []
    let groupKey = ''
    const close = () => {
      if (group.length > 1) beams.push(group)
      group = []
    }
    for (const c of own) {
      const m = song.measures[c.measure]
      const key = m
        ? `${c.measure}:${Math.floor((c.tick - m.startTick) / beamTicks(m, song.ppq))}`
        : ''
      if (c.beats >= 1 || !m) {
        close()
        continue
      }
      if (key !== groupKey) close()
      groupKey = key
      group.push(c)
    }
    close()
    chords.push(...own)
  }

  for (const beam of beams) {
    const heads = beam.flatMap((c) => c.heads)
    const clef = beam[0]!.clef
    const mean = heads.reduce((s, h) => s + h.pos, 0) / heads.length
    for (const c of beam) {
      c.beamed = true
      c.stemUp = mean < MIDDLE_LINE[clef]
    }
  }
  for (const c of chords) flipSeconds(c)

  return { fifths, ppq: song.ppq, chords: chords.toSorted((a, b) => a.tick - b.tick), beams }
}

/** Heads a step apart sit on opposite sides of the stem. */
function flipSeconds(c: Chord): void {
  const order = c.stemUp ? c.heads : c.heads.toReversed()
  for (let i = 1; i < order.length; i++) {
    const prev = order[i - 1]!
    const h = order[i]!
    h.flipped = Math.abs(h.pos - prev.pos) === 1 && !prev.flipped
  }
}

/** Song ticks at a time in seconds, linear within each bar. */
export function tickAt(measures: readonly Measure[], sec: number): number {
  const m = measures.find((x) => sec < x.endSec) ?? (sec < 0 ? measures[0] : measures.at(-1))
  if (!m) return 0
  const span = m.endSec - m.startSec || 1
  return m.startTick + ((sec - m.startSec) / span) * (m.endTick - m.startTick)
}
