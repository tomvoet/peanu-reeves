import type { Hand, SongNote } from '../types'

/** What was played, as it arrived from the keyboard. Times are seconds (song time for takes). */
export type TakeEvent =
  | { readonly kind: 'on'; readonly t: number; readonly pitch: number; readonly velocity: number }
  | { readonly kind: 'off'; readonly t: number; readonly pitch: number }
  | { readonly kind: 'pedal'; readonly t: number; readonly cc: number; readonly value: number }

export interface TakeNote {
  readonly pitch: number
  readonly start: number
  /** Key release. */
  readonly end: number
  /** When the sound stops: the release, or later if the sustain pedal held it. */
  readonly soundEnd: number
  readonly velocity: number
}

export type Interval = readonly [start: number, end: number]

export interface TakeNotes {
  readonly notes: readonly TakeNote[]
  /** Sustain pedal down intervals. */
  readonly pedal: readonly Interval[]
}

const SUSTAIN = 64
const PEDAL_DOWN = 64
/** Length given to a note whose release was never recorded. */
const DANGLING_SEC = 0.5

/** Pairs note-ons with their note-offs and works out how long each note actually sounded. */
export function notesOf(events: readonly TakeEvent[]): TakeNotes {
  const sorted = events.toSorted((a, b) => a.t - b.t)
  const last = sorted.at(-1)?.t ?? 0

  const pedal: Interval[] = []
  let pedalFrom: number | null = null
  for (const e of sorted) {
    if (e.kind !== 'pedal' || e.cc !== SUSTAIN) continue
    if (e.value >= PEDAL_DOWN && pedalFrom === null) pedalFrom = e.t
    else if (e.value < PEDAL_DOWN && pedalFrom !== null) {
      pedal.push([pedalFrom, e.t])
      pedalFrom = null
    }
  }
  if (pedalFrom !== null) pedal.push([pedalFrom, Math.max(last, pedalFrom)])

  const open = new Map<number, { start: number; velocity: number }>()
  const raw: { pitch: number; start: number; end: number; velocity: number }[] = []
  for (const e of sorted) {
    if (e.kind === 'on') {
      const prev = open.get(e.pitch)
      if (prev) raw.push({ pitch: e.pitch, start: prev.start, end: e.t, velocity: prev.velocity })
      open.set(e.pitch, { start: e.t, velocity: e.velocity })
    } else if (e.kind === 'off') {
      const prev = open.get(e.pitch)
      if (!prev) continue
      raw.push({ pitch: e.pitch, start: prev.start, end: e.t, velocity: prev.velocity })
      open.delete(e.pitch)
    }
  }
  for (const [pitch, prev] of open) {
    raw.push({
      pitch,
      start: prev.start,
      end: Math.max(last, prev.start + DANGLING_SEC),
      velocity: prev.velocity,
    })
  }

  const notes = raw
    .map((n) => ({ ...n, soundEnd: sustainedUntil(n.end, pedal) }))
    .toSorted((a, b) => a.start - b.start || a.pitch - b.pitch)

  return { notes, pedal }
}

function sustainedUntil(release: number, pedal: readonly Interval[]): number {
  const held = pedal.find(([from, to]) => release >= from && release < to)
  return held ? held[1] : release
}

/** Whether the sustain pedal is down at a time. */
export function pedalDown(pedal: readonly Interval[], t: number): boolean {
  return pedal.some(([from, to]) => t >= from && t < to)
}

/** A take note matched to the score note it was meant to be, if any. */
export interface AlignedNote extends TakeNote {
  readonly hand: Hand
  /** Score note it was matched to. */
  readonly ref: SongNote | null
  /** Real-time deviation from the score note's start, in ms (negative = early). */
  readonly deviationMs: number | null
}

/** Within this many song seconds a played note counts as the score note of the same pitch. */
const MATCH_WINDOW = 0.35

/**
 * Pairs played notes with score notes (same pitch, nearest start) so they can be drawn in the
 * right hand's colour and compared for timing and length.
 */
export function alignTake(
  notes: readonly TakeNote[],
  score: readonly SongNote[],
  tempo: number,
): AlignedNote[] {
  const used = new Set<string>()
  const byPitch = new Map<number, SongNote[]>()
  for (const n of score) {
    const list = byPitch.get(n.pitch) ?? []
    list.push(n)
    byPitch.set(n.pitch, list)
  }

  return notes.map((n) => {
    let best: SongNote | null = null
    for (const candidate of byPitch.get(n.pitch) ?? []) {
      if (used.has(candidate.id)) continue
      const dist = Math.abs(candidate.startSec - n.start)
      if (dist <= MATCH_WINDOW && (!best || dist < Math.abs(best.startSec - n.start)))
        best = candidate
    }
    if (best) used.add(best.id)

    return {
      ...n,
      hand: best?.hand ?? (n.pitch < 60 ? 'L' : 'R'),
      ref: best,
      deviationMs: best ? ((n.start - best.startSec) / tempo) * 1000 : null,
    }
  })
}

/** Keeps only events from the last `seconds` before `now`, for an always-on capture buffer. */
export function trimBuffer(events: TakeEvent[], now: number, seconds: number): TakeEvent[] {
  const from = now - seconds
  const first = events.findIndex((e) => e.t >= from)
  return first <= 0 ? events : events.slice(first)
}

/** Shifts a list of events so the first one starts at `start`. */
export function shiftEvents(events: readonly TakeEvent[], by: number): TakeEvent[] {
  return events.map((e) => ({ ...e, t: e.t + by }))
}

/** Events between two times, with notes still sounding at the cut closed at the cut. */
export function sliceEvents(events: readonly TakeEvent[], from: number, to: number): TakeEvent[] {
  const inside = events.filter((e) => e.t >= from && e.t <= to)
  const held = new Set<number>()
  for (const e of inside) {
    if (e.kind === 'on') held.add(e.pitch)
    else if (e.kind === 'off') held.delete(e.pitch)
  }
  return [...inside, ...Array.from(held, (pitch) => ({ kind: 'off' as const, t: to, pitch }))]
}
