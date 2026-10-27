import type { Hand } from '../types'

export interface ExpectedNote {
  id: string
  pitch: number
  /** Song seconds. */
  start: number
  hand: Hand
  measure: number
}

export type MatchEvent =
  | { type: 'hit'; note: ExpectedNote; time: number; deviationMs: number }
  | { type: 'wrong'; pitch: number; time: number; measure: number }
  | { type: 'miss'; note: ExpectedNote }

export interface WaitOptions {
  /** 'all': every note of the chord must be played. 'any': one note releases the chord. */
  chord: 'all' | 'any'
  /** Wrong keys that are still held keep playback halted. */
  wrongBlocks: boolean
  /** Hands the music waits for. The other hand is scored in time as usual. Default both. */
  hands?: readonly Hand[]
}

export interface MatcherOptions {
  /** Window at 100% tempo. It stretches in real time as tempo drops. */
  toleranceMs: number
  tempoFactor: number
  /** Input latency (ms, real time) subtracted from every played note. */
  offsetMs: number
  wait: WaitOptions | null
  /** Notes starting within this many song seconds form one chord in wait mode. */
  chordWindow?: number
}

/**
 * Deterministic state machine pairing played note-ons with expected notes.
 * All times are song seconds, the caller converts from the audio clock.
 */
export class Matcher {
  private pending: ExpectedNote[]
  private readonly wrongHeld = new Set<number>()

  constructor(
    notes: readonly ExpectedNote[],
    private readonly measureAt: (songSec: number) => number,
    private opts: MatcherOptions,
  ) {
    this.pending = notes.toSorted((a, b) => a.start - b.start || a.pitch - b.pitch)
  }

  get remaining(): readonly ExpectedNote[] {
    return this.pending
  }

  setTempo(tempoFactor: number): void {
    this.opts = { ...this.opts, tempoFactor }
  }

  private get tolerance(): number {
    return this.opts.toleranceMs / 1000
  }

  private adjust(t: number): number {
    return t - (this.opts.offsetMs / 1000) * this.opts.tempoFactor
  }

  private waitsFor(n: ExpectedNote): boolean {
    const hands = this.opts.wait?.hands
    return !!this.opts.wait && (!hands || hands.includes(n.hand))
  }

  /** Notes the transport has to wait for in wait mode. */
  currentChord(): ExpectedNote[] {
    const first = this.pending.find((n) => this.waitsFor(n))
    if (!first) return []

    const window = this.opts.chordWindow ?? 0.05
    return this.pending.filter((n) => this.waitsFor(n) && n.start <= first.start + window)
  }

  /** Song time playback must halt at in wait mode, or null when free to run. */
  holdPoint(): number | null {
    return this.pending.find((n) => this.waitsFor(n))?.start ?? null
  }

  blockedByWrongNotes(): boolean {
    return !!this.opts.wait?.wrongBlocks && this.wrongHeld.size > 0
  }

  noteOn(pitch: number, time: number): MatchEvent {
    const t = this.adjust(time)
    // While halted, the raw time sits at the chord, so the offset must not push it out of the window.
    const fullChord = this.opts.wait ? this.currentChord() : []
    const chord = fullChord.filter((n) => time >= n.start - this.tolerance)

    let best: ExpectedNote | undefined
    let bestDist = Infinity
    for (const n of this.pending) {
      const inChord = chord.includes(n)
      if (n.start - t > this.tolerance && !inChord) break
      if (n.pitch !== pitch) continue
      const dist = Math.abs(n.start - t)
      if ((dist <= this.tolerance || inChord) && dist < bestDist) {
        best = n
        bestDist = dist
      }
    }

    if (!best) {
      this.wrongHeld.add(pitch)
      return { type: 'wrong', pitch, time: t, measure: this.measureAt(t) }
    }

    this.pending.splice(this.pending.indexOf(best), 1)
    if (this.opts.wait?.chord === 'any' && fullChord.includes(best)) {
      this.pending = this.pending.filter((n) => !fullChord.includes(n))
    }

    const deviationMs = ((t - best.start) / this.opts.tempoFactor) * 1000
    return { type: 'hit', note: best, time: t, deviationMs }
  }

  noteOff(pitch: number): void {
    this.wrongHeld.delete(pitch)
  }

  /** Emits misses for notes whose window has closed. Notes wait mode holds for never expire. */
  advance(time: number): MatchEvent[] {
    const before = this.adjust(time) - this.tolerance
    if (!this.opts.wait) return this.expire(before)

    const events: MatchEvent[] = []
    this.pending = this.pending.filter((n) => {
      if (this.waitsFor(n) || n.start >= before) return true
      events.push({ type: 'miss', note: n })
      return false
    })
    return events
  }

  /** Ends the pass: every note starting before `until` that is still pending is a miss. */
  flush(until = Infinity): MatchEvent[] {
    return this.expire(until)
  }

  private expire(before: number): MatchEvent[] {
    const events: MatchEvent[] = []
    while (this.pending[0] && this.pending[0].start < before) {
      events.push({ type: 'miss', note: this.pending.shift()! })
    }
    return events
  }
}
