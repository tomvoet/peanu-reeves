import type { TakeNote } from './take'

/** Krumhansl–Kessler key profiles, starting at the tonic. */
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88] as const
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17] as const
const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'] as const

export interface KeyGuess {
  readonly tonic: (typeof NAMES)[number]
  readonly mode: 'major' | 'minor'
  /** Correlation with the best profile, 0 to 1. Below about 0.6 the guess is weak. */
  readonly confidence: number
}

function correlation(a: readonly number[], b: readonly number[]): number {
  const mean = (v: readonly number[]): number => v.reduce((s, x) => s + x, 0) / v.length
  const ma = mean(a)
  const mb = mean(b)
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! - ma
    const y = b[i]! - mb
    num += x * y
    da += x * x
    db += y * y
  }
  return da && db ? num / Math.sqrt(da * db) : 0
}

/** Most likely key of what was played, weighting pitch classes by how long they sounded. */
export function guessKey(
  notes: readonly Pick<TakeNote, 'pitch' | 'start' | 'soundEnd'>[],
): KeyGuess | null {
  if (notes.length < 8) return null

  const weights = Array.from<number>({ length: 12 }).fill(0)
  for (const n of notes) weights[n.pitch % 12]! += Math.max(0.05, n.soundEnd - n.start)

  let best: KeyGuess | null = null
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = Array.from({ length: 12 }, (_, i) => weights[(i + tonic) % 12]!)
    for (const [mode, profile] of [
      ['major', MAJOR],
      ['minor', MINOR],
    ] as const) {
      const r = correlation(rotated, profile)
      if (!best || r > best.confidence) best = { tonic: NAMES[tonic]!, mode, confidence: r }
    }
  }
  return best
}

/** Key signature by major tonic pitch class, F♯ rather than G♭. */
const FIFTHS_BY_PC = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5] as const

/** Sharps (positive) or flats (negative) in the key signature of a key. */
export function keyFifths(key: KeyGuess): number {
  const major = (NAMES.indexOf(key.tonic) + (key.mode === 'minor' ? 3 : 0)) % 12
  return FIFTHS_BY_PC[major]!
}
