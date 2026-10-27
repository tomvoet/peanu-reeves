import type { LoopRange } from '../clock/transport'
import type { Measure } from '../types'

export interface MeasureRange {
  startMeasure: number
  endMeasure: number
}

/** Inclusive measure range (0-based) → song seconds. */
export function measureRangeToLoop(measures: readonly Measure[], range: MeasureRange): LoopRange {
  const last = measures.length - 1
  const a = Math.min(Math.max(0, Math.min(range.startMeasure, range.endMeasure)), last)
  const b = Math.min(Math.max(range.startMeasure, range.endMeasure), last)

  return { start: measures[a]!.startSec, end: measures[b]!.endSec }
}
