import type { Piano } from '../audio/piano'
import type { TakeNote } from './take'

/** Real seconds of notes handed to the audio clock in advance. */
const AHEAD = 0.3
const TICK_MS = 50

/** Plays recorded notes on the piano from a position. `position` follows the audio clock. */
export class TakePlayer {
  private timer: ReturnType<typeof setInterval> | null = null
  private next = 0
  /** Audio-clock time that corresponds to recording time 0. */
  private origin = 0

  constructor(
    private readonly piano: Piano,
    private readonly notes: readonly TakeNote[],
    private readonly now: () => number,
    private readonly onEnd: () => void = () => {},
  ) {}

  get playing(): boolean {
    return this.timer !== null
  }

  get duration(): number {
    return this.notes.reduce((m, n) => Math.max(m, n.soundEnd), 0)
  }

  /** Current recording time while playing. */
  get position(): number {
    return this.now() - this.origin
  }

  play(from = 0): void {
    this.stop()
    void this.piano.ctx.resume()
    this.origin = this.now() - from
    this.next = this.notes.findIndex((n) => n.start >= from)
    if (this.next < 0) this.next = this.notes.length
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.piano.stopScheduled()
  }

  private tick(): void {
    const horizon = this.position + AHEAD
    while (this.next < this.notes.length) {
      const n = this.notes[this.next]!
      if (n.start >= horizon) break
      this.next++
      this.piano.schedule(n.pitch, n.velocity, this.origin + n.start, n.soundEnd - n.start)
    }
    if (this.position > this.duration + 0.5) {
      this.stop()
      this.onEnd()
    }
  }
}
