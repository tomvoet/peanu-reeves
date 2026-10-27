import type { MeasureRange } from './loop'

export interface BarResult {
  measure: number
  accuracy: number | null
}

export interface DrillStep extends MeasureRange {
  /** Lowest bar accuracy inside the step. */
  worst: number
}

/** Weak bars spanned by one step at most, before padding. */
const MAX_SPAN = 4

/**
 * Groups bars below `threshold` into loops padded by a bar on each side, worst first.
 * Weak bars close enough that their padded loops would touch share one step.
 */
export function planDrill(
  results: readonly BarResult[],
  measureCount: number,
  threshold: number,
  max = 5,
): DrillStep[] {
  const weak = results
    .filter((r): r is BarResult & { accuracy: number } => r.accuracy !== null)
    .filter((r) => r.accuracy < threshold && r.measure < measureCount)
    .toSorted((a, b) => a.measure - b.measure)

  const groups: { from: number; to: number; worst: number }[] = []
  for (const r of weak) {
    const g = groups.at(-1)
    if (g && r.measure - g.to <= 2 && r.measure - g.from < MAX_SPAN) {
      g.to = r.measure
      g.worst = Math.min(g.worst, r.accuracy)
    } else groups.push({ from: r.measure, to: r.measure, worst: r.accuracy })
  }

  return groups
    .map((g) => ({
      startMeasure: Math.max(0, g.from - 1),
      endMeasure: Math.min(measureCount - 1, g.to + 1),
      worst: g.worst,
    }))
    .toSorted((a, b) => a.worst - b.worst)
    .slice(0, max)
}
