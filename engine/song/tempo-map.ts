export interface TempoEvent {
  ticks: number
  bpm: number
}

interface Segment {
  tick: number
  sec: number
  secPerTick: number
}

export class TempoMap {
  private readonly segments: Segment[] = []

  constructor(
    readonly ppq: number,
    tempos: readonly TempoEvent[],
  ) {
    const sorted = tempos.toSorted((a, b) => a.ticks - b.ticks)
    if (sorted[0]?.ticks !== 0) sorted.unshift({ ticks: 0, bpm: 120 })

    for (const t of sorted) {
      const prev = this.segments.at(-1)
      const sec = prev ? prev.sec + (t.ticks - prev.tick) * prev.secPerTick : 0
      const segment: Segment = { tick: t.ticks, sec, secPerTick: 60 / (t.bpm * ppq) }
      if (prev?.tick === t.ticks) this.segments[this.segments.length - 1] = segment
      else this.segments.push(segment)
    }
  }

  ticksToSeconds(tick: number): number {
    const s = this.find((seg) => seg.tick <= tick)
    return s.sec + (tick - s.tick) * s.secPerTick
  }

  secondsToTicks(sec: number): number {
    const s = this.find((seg) => seg.sec <= sec)
    return s.tick + (sec - s.sec) / s.secPerTick
  }

  bpmAt(tick: number): number {
    return 60 / (this.find((seg) => seg.tick <= tick).secPerTick * this.ppq)
  }

  private find(pred: (s: Segment) => boolean): Segment {
    return this.segments.findLast(pred) ?? this.segments[0]!
  }
}
