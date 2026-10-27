import type { Hand } from '../types'

export interface SeparableNote {
  pitch: number
  startSec: number
  endSec: number
}

/** Cost weights, tuned with `vp run eval:hands`. */
export interface SeparationWeights {
  /** Per semitone a hand's centre moves between its notes (beyond a few semitones). */
  move: number
  /** Extra per semitone when a jump is too fast to make comfortably. */
  leap: number
  /** Per semitone a hand's span goes past an octave. */
  stretch: number
  /** Change in a hand's rhythm (log ratio of successive inter-onset intervals). */
  rhythm: number
  /** Left hand above, right hand below their usual register. */
  register: number
  /** Hands crossing over each other. */
  cross: number
  /** A hand playing while it still holds notes. */
  overlap: number
  /** Per held note a hand has to let go early to reach new notes (the pedal can cover it). */
  release: number
}

export const DEFAULT_WEIGHTS = {
  move: 0.6,
  leap: 0.8,
  stretch: 6,
  rhythm: 2,
  register: 0.35,
  cross: 12,
  overlap: 0.5,
  release: 2,
} as const satisfies SeparationWeights

/** Physically impossible or close to it. */
const IMPOSSIBLE = 1000
const MAX_SPAN = 16
const MAX_NOTES = 5
const BEAM = 48
/** Onsets closer than this are played together. */
const CHORD_WINDOW = 0.035
/** A note released this close to a new onset counts as already released (legato). */
const RELEASE_SLACK = 0.06

interface HandCtx {
  /** Held notes: pitch and release time. */
  readonly held: readonly { pitch: number; end: number }[]
  /** Centre of the last notes played, null before the hand has played. */
  readonly center: number | null
  /** Notes played in the last moment: the stretch of keys the hand is currently covering. */
  readonly recent: readonly { pitch: number; t: number }[]
  readonly lastOnset: number | null
  /** Last inter-onset interval. */
  readonly ioi: number | null
}

/** Where a hand rests before it first plays: around C3 and G4. */
const HOME = { L: 48, R: 67 } as const satisfies Record<Hand, number>

/** How long a hand keeps "covering" keys it just played, e.g. through an arpeggio. */
const RECENT_SEC = 0.8

interface State {
  readonly cost: number
  readonly L: HandCtx
  readonly R: HandCtx
  /** Index of the predecessor state in the previous step. */
  readonly prev: number
  /** Hands for the current group's notes, low to high. */
  readonly hands: readonly Hand[]
}

const center = (ps: readonly number[]): number => (ps[0]! + ps.at(-1)!) / 2

function handCost(
  ctx: HandCtx,
  pitches: readonly number[],
  ends: readonly number[],
  t: number,
  hand: Hand,
  w: SeparationWeights,
): { cost: number; next: HandCtx } {
  let held = ctx.held.filter((h) => h.end > t + RELEASE_SLACK)
  let cost = 0

  // Notes struck together must fit one hand.
  const own = pitches.at(-1)! - pitches[0]!
  if (pitches.length > MAX_NOTES || own > MAX_SPAN) cost += IMPOSSIBLE

  const all = [...held.map((h) => h.pitch), ...pitches]
  const span = Math.max(...all) - Math.min(...all)
  if (held.length && (span > MAX_SPAN || all.length > MAX_NOTES)) {
    // Held notes have to go. Cheap if the pedal can carry them, but still a cost.
    cost += held.length * w.release
    held = []
  }

  const reach = held.length ? span : own
  if (reach > 12) cost += (reach - 12) * w.stretch

  const c = center(pitches)
  const recent = ctx.recent.filter((r) => t - r.t < RECENT_SEC)
  // Movement is measured from the keys the hand is covering, so arpeggios inside one hand
  // position are free. Without recent notes it is measured from where the hand last was.
  let dist = 0
  if (recent.length) {
    const lo = Math.min(...recent.map((r) => r.pitch))
    const hi = Math.max(...recent.map((r) => r.pitch))
    const outside = Math.max(0, lo - pitches[0]!, pitches.at(-1)! - hi)
    const window = Math.max(hi, pitches.at(-1)!) - Math.min(lo, pitches[0]!)
    dist = window > 12 ? Math.max(outside, window - 12) : Math.max(0, outside - 3)
  } else {
    dist = Math.max(0, Math.abs(c - (ctx.center ?? HOME[hand])) - 3)
  }

  const dt = ctx.lastOnset === null ? 1 : Math.max(0.02, t - ctx.lastOnset)
  cost += dist * w.move
  // Leaps get expensive when there is little time to make them.
  cost += (Math.max(0, dist - 4) * w.leap * 0.15) / dt
  if (held.length) cost += held.length * w.overlap

  let ioi: number | null = ctx.ioi
  if (ctx.lastOnset !== null) {
    const now = t - ctx.lastOnset
    if (ctx.ioi !== null && now < 2 && ctx.ioi < 2) {
      cost += Math.min(2, Math.abs(Math.log(now / ctx.ioi))) * w.rhythm
    }
    ioi = now
  }

  cost += (hand === 'L' ? Math.max(0, c - 62) : Math.max(0, 57 - c)) * w.register

  return {
    cost,
    next: {
      held: [...held, ...pitches.map((pitch, i) => ({ pitch, end: ends[i] ?? t }))],
      center: c,
      recent: [...recent, ...pitches.map((pitch) => ({ pitch, t }))],
      lastOnset: t,
      ioi,
    },
  }
}

export interface PlayabilityReport {
  /** Chords where one hand would need to stretch past a tenth. */
  spans: number
  /** Chords with more than five notes in one hand. */
  crowded: number
  /** Jumps of more than an octave in under 80 ms within one hand. */
  leaps: number
}

/** Counts physically implausible spots in a hand assignment. Needs no reference answer. */
export function playability(
  notes: readonly SeparableNote[],
  hands: readonly Hand[],
): PlayabilityReport {
  const report: PlayabilityReport = { spans: 0, crowded: 0, leaps: 0 }

  for (const hand of ['L', 'R'] as const) {
    const mine = notes
      .map((n, i) => ({ n, h: hands[i] }))
      .filter((x) => x.h === hand)
      .map((x) => x.n)
      .sort((a, b) => a.startSec - b.startSec)

    let last: { t: number; c: number } | null = null
    for (let i = 0; i < mine.length;) {
      const t = mine[i]!.startSec
      const group: SeparableNote[] = []
      while (i < mine.length && mine[i]!.startSec - t < CHORD_WINDOW) group.push(mine[i++]!)

      const all = group.map((n) => n.pitch)
      if (Math.max(...all) - Math.min(...all) > MAX_SPAN) report.spans++
      if (all.length > MAX_NOTES) report.crowded++

      const c = center(group.map((n) => n.pitch).sort((a, b) => a - b))
      if (last && t - last.t < 0.08 && Math.abs(c - last.c) > 12) report.leaps++
      last = { t, c }
    }
  }

  return report
}

/**
 * Assigns each note to a hand by searching for the cheapest playable path through the piece:
 * hard limits on span and notes per hand, then costs for movement, rhythm changes, crossing and
 * register. `fixed` pins notes (by index) to a hand and the rest is solved around them.
 */
export interface SeparationOptions {
  fixed?: ReadonlyMap<number, Hand>
  weights?: SeparationWeights
}

export function separateHands(
  notes: readonly SeparableNote[],
  opts: SeparationOptions = {},
): Hand[] {
  const w = opts.weights ?? DEFAULT_WEIGHTS
  const order = notes
    .map((_, i) => i)
    .sort((a, b) => {
      const x = notes[a]!
      const y = notes[b]!
      return x.startSec - y.startSec || x.pitch - y.pitch
    })

  const groups: number[][] = []
  for (const i of order) {
    const g = groups.at(-1)
    if (g && notes[i]!.startSec - notes[g[0]!]!.startSec < CHORD_WINDOW) g.push(i)
    else groups.push([i])
  }
  for (const g of groups) g.sort((a, b) => notes[a]!.pitch - notes[b]!.pitch)

  const start: HandCtx = { held: [], center: null, recent: [], lastOnset: null, ioi: null }
  let beam: State[] = [{ cost: 0, L: start, R: start, prev: -1, hands: [] }]
  const history: State[][] = []

  for (const g of groups) {
    const t = notes[g[0]!]!.startSec
    const pitches = g.map((i) => notes[i]!.pitch)
    const ends = g.map((i) => notes[i]!.endSec)
    const fixed = g.map((i) => opts.fixed?.get(i))

    // Splits are contiguous by pitch: the lowest k notes go left.
    const options: (readonly Hand[])[] = []
    for (let k = 0; k <= g.length; k++) {
      const hands = g.map((_, j): Hand => (j < k ? 'L' : 'R'))
      if (hands.every((h, j) => !fixed[j] || fixed[j] === h)) options.push(hands)
    }
    if (!options.length) options.push(g.map((_, j): Hand => fixed[j] ?? 'R'))

    const next: State[] = []
    beam.forEach((s, si) => {
      for (const hands of options) {
        let cost = s.cost
        let L = s.L
        let R = s.R

        const lp: number[] = []
        const rp: number[] = []
        const le: number[] = []
        const re: number[] = []
        hands.forEach((h, j) => {
          if (h === 'L') {
            lp.push(pitches[j]!)
            le.push(ends[j]!)
          } else {
            rp.push(pitches[j]!)
            re.push(ends[j]!)
          }
        })

        if (lp.length) {
          const r = handCost(L, lp, le, t, 'L', w)
          cost += r.cost
          L = r.next
        }
        if (rp.length) {
          const r = handCost(R, rp, re, t, 'R', w)
          cost += r.cost
          R = r.next
        }

        if (L.center !== null && R.center !== null && L.center > R.center + 1)
          cost += w.cross + (L.center - R.center) * 0.5
        next.push({ cost, L, R, prev: si, hands })
      }
    })

    next.sort((a, b) => a.cost - b.cost)
    beam = next.slice(0, BEAM)
    history.push(beam)
  }

  const result: Hand[] = notes.map(() => 'R')
  let idx = 0
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const s = history[gi]![idx]!
    groups[gi]!.forEach((noteIndex, j) => (result[noteIndex] = s.hands[j]!))
    idx = s.prev
  }
  return result
}
