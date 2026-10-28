const DAY_MS = 86_400_000

/**
 * Hybrid logical clock. Timestamps sort as plain strings: wall time, a counter for writes in
 * the same millisecond, then the device id as tie-breaker.
 */
export class Clock {
  private ms = 0
  private counter = 0

  constructor(
    public device: string,
    private readonly now: () => number = Date.now,
  ) {}

  tick(): string {
    const now = this.now()
    if (now > this.ms) {
      this.ms = now
      this.counter = 0
    } else {
      this.counter++
    }
    return format(this.ms, this.counter, this.device)
  }

  /** Moves past a timestamp seen from another device, unless that device's clock is far ahead. */
  observe(hlc: string): void {
    const seen = parse(hlc)
    if (!seen || seen.ms > this.now() + DAY_MS) return
    if (seen.ms > this.ms) {
      this.ms = seen.ms
      this.counter = seen.counter
    } else if (seen.ms === this.ms) {
      this.counter = Math.max(this.counter, seen.counter)
    }
  }
}

const format = (ms: number, counter: number, device: string): string =>
  `${ms.toString(36).padStart(10, '0')}.${counter.toString(36).padStart(5, '0')}.${device}`

function parse(hlc: string): { ms: number; counter: number } | null {
  const [ms, counter] = hlc.split('.')
  const out = { ms: parseInt(ms ?? '', 36), counter: parseInt(counter ?? '', 36) }
  return Number.isFinite(out.ms) && Number.isFinite(out.counter) ? out : null
}
