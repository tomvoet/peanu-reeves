import type { MatchEvent } from '../matcher/matcher'
import type { MeasureRange } from '../modes/loop'

export interface NoteCounts {
  hit: number
  wrong: number
  miss: number
}

export interface MeasureStats extends NoteCounts {
  measure: number
  accuracy: number | null
  meanDevMs: number | null
  stdDevMs: number | null
}

export interface PassStats {
  notes: NoteCounts
  accuracy: number | null
  meanDevMs: number | null
  perMeasure: MeasureStats[]
}

export const emptyCounts = (): NoteCounts => ({ hit: 0, wrong: 0, miss: 0 })

export function accuracyOf({ hit, wrong, miss }: NoteCounts): number | null {
  const total = hit + wrong + miss
  return total ? hit / total : null
}

function meanStd(values: readonly number[]): [mean: number | null, std: number | null] {
  if (!values.length) return [null, null]

  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length
  return [mean, Math.sqrt(variance)]
}

const measureOf = (e: MatchEvent): number => (e.type === 'wrong' ? e.measure : e.note.measure)

export function aggregatePass(
  events: readonly MatchEvent[],
  measures: readonly number[],
): PassStats {
  const buckets = new Map<number, { counts: NoteCounts; devs: number[] }>()
  for (const m of measures) buckets.set(m, { counts: emptyCounts(), devs: [] })

  for (const e of events) {
    const m = measureOf(e)
    let b = buckets.get(m)
    if (!b) buckets.set(m, (b = { counts: emptyCounts(), devs: [] }))
    b.counts[e.type]++
    if (e.type === 'hit') b.devs.push(e.deviationMs)
  }

  const perMeasure = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([measure, { counts, devs }]): MeasureStats => {
      const [meanDevMs, stdDevMs] = meanStd(devs)
      return { measure, ...counts, accuracy: accuracyOf(counts), meanDevMs, stdDevMs }
    })

  const notes = perMeasure.reduce(
    (acc, m) => ({ hit: acc.hit + m.hit, wrong: acc.wrong + m.wrong, miss: acc.miss + m.miss }),
    emptyCounts(),
  )
  const [meanDevMs] = meanStd(events.flatMap((e) => (e.type === 'hit' ? [e.deviationMs] : [])))
  return { notes, accuracy: accuracyOf(notes), meanDevMs, perMeasure }
}

/**
 * Picks the contiguous run of up to `width` measures with the most errors.
 * Returns null when every measure was clean.
 */
export function worstMeasures(perMeasure: readonly MeasureStats[], width = 2): MeasureRange | null {
  const scored = perMeasure.filter((m) => m.hit + m.wrong + m.miss > 0)
  const errors = (m: MeasureStats) => m.wrong + m.miss + (m.stdDevMs ?? 0) / 1000

  let best: (MeasureRange & { score: number }) | null = null
  for (let i = 0; i < scored.length; i++) {
    let score = 0
    let j = i
    for (; j < scored.length && j < i + width; j++) {
      if (j > i && scored[j]!.measure !== scored[j - 1]!.measure + 1) break
      score += errors(scored[j]!)
    }
    if (score > 0.001 && (!best || score > best.score)) {
      best = { startMeasure: scored[i]!.measure, endMeasure: scored[j - 1]!.measure, score }
    }
  }

  return best && { startMeasure: best.startMeasure, endMeasure: best.endMeasure }
}
