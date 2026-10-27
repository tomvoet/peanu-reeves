import type { Hand, HandSplit, TrackInfo } from '../types'
import { separateHands, type SeparableNote } from './hand-separation'

export const MIDDLE_C = 60

const RIGHT_NAME = /\b(right|rh|r\.h\.?|treble|upper|rechts|droite|destra)\b/i
const LEFT_NAME = /\b(left|lh|l\.h\.?|bass|lower|links|gauche|sinistra)\b/i

/** Hand named in a track name such as "Piano right" or "LH", if any. */
export function handFromName(name: string): Hand | null {
  const right = RIGHT_NAME.test(name)
  const left = LEFT_NAME.test(name)
  return right === left ? null : right ? 'R' : 'L'
}

/**
 * Hands decided by the file itself: every playable track named for a hand, or exactly two
 * tracks (lower one left). Null when the tracks do not tell.
 */
export function trackHands(tracks: readonly TrackInfo[]): Record<number, Hand> | null {
  const playable = tracks.filter((t) => t.noteCount > 0)
  const named = playable.map((t) => handFromName(t.name))
  if (playable.length > 1 && named.every(Boolean) && new Set(named).size === 2) {
    return Object.fromEntries(playable.map((t, i) => [t.index, named[i]!]))
  }
  if (playable.length !== 2) return null

  const [a, b] = playable.toSorted((x, y) => x.meanPitch - y.meanPitch)
  return { [a!.index]: 'L', [b!.index]: 'R' }
}

/** Picks the split to use. `auto` trusts the file's tracks when they tell, else works it out. */
export function resolveHandSplit(tracks: readonly TrackInfo[], split?: HandSplit): HandSplit {
  const fixes = split?.fixes && Object.keys(split.fixes).length ? { fixes: split.fixes } : {}
  const mode = split?.mode ?? 'auto'
  if (mode === 'pitch') return { mode, splitPitch: split?.splitPitch ?? MIDDLE_C, ...fixes }
  if (mode === 'tracks' && split?.trackMap) return { mode, trackMap: split.trackMap, ...fixes }
  if (mode === 'smart') return { mode, ...fixes }

  const fromFile = trackHands(tracks)
  return fromFile ? { mode: 'tracks', trackMap: fromFile, ...fixes } : { mode: 'smart', ...fixes }
}

export function handFor(note: { pitch: number; track: number }, split: HandSplit): Hand {
  if (split.mode === 'tracks' && split.trackMap) return split.trackMap[note.track] ?? 'R'
  return note.pitch < (split.splitPitch ?? MIDDLE_C) ? 'L' : 'R'
}

/** Hands for every note under a resolved split, corrections included. */
export function assignHands(
  notes: readonly (SeparableNote & { id: string; track: number })[],
  split: HandSplit,
): Hand[] {
  const fixes = split.fixes ?? {}
  if (split.mode === 'smart') {
    const fixed = new Map<number, Hand>()
    notes.forEach((n, i) => {
      const hand = fixes[n.id]
      if (hand) fixed.set(i, hand)
    })
    return separateHands(notes, { fixed })
  }
  return notes.map((n) => fixes[n.id] ?? handFor(n, split))
}
