import type { Song } from '../types'

/** `hand` is 0 for left, 1 for right. */
export type ThumbNote = [startSec: number, durationSec: number, pitch: number, hand: 0 | 1]

export interface ThumbData {
  durationSec: number
  barStarts: number[]
  notes: ThumbNote[]
}

const MAX_NOTES = 700

/** A small, evenly thinned copy of a song's notes for library thumbnails. */
export function thumbnailOf(song: Song): ThumbData {
  const step = Math.max(1, Math.ceil(song.notes.length / MAX_NOTES))
  const round = (v: number) => Math.round(v * 100) / 100

  return {
    durationSec: round(song.durationSec),
    barStarts: song.measures.map((m) => round(m.startSec)),
    notes: song.notes
      .filter((_, i) => i % step === 0)
      .map((n): ThumbNote => [
        round(n.startSec),
        round(n.endSec - n.startSec),
        n.pitch,
        n.hand === 'L' ? 0 : 1,
      ]),
  }
}

/** Thumbnail data for a free recording. Hands are guessed from middle C. */
export function thumbnailOfNotes(
  notes: readonly { pitch: number; start: number; end: number }[],
  durationSec: number,
  barSec?: number,
): ThumbData {
  const step = Math.max(1, Math.ceil(notes.length / MAX_NOTES))
  const round = (v: number) => Math.round(v * 100) / 100
  const bars = barSec ? Math.ceil(durationSec / barSec) : 0

  return {
    durationSec: round(durationSec),
    barStarts: Array.from({ length: bars }, (_, i) => round(i * (barSec ?? 0))),
    notes: notes
      .filter((_, i) => i % step === 0)
      .map((n): ThumbNote => [
        round(n.start),
        round(n.end - n.start),
        n.pitch,
        n.pitch < 60 ? 0 : 1,
      ]),
  }
}
