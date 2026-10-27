import type { Measure } from '../types'
import type { TempoMap } from './tempo-map'

export interface TimeSignatureEvent {
  ticks: number
  numerator: number
  denominator: number
}

export function buildMeasures(
  tempoMap: TempoMap,
  signatures: readonly TimeSignatureEvent[],
  endTick: number,
): Measure[] {
  const sigs = signatures.toSorted((a, b) => a.ticks - b.ticks)
  if (sigs[0]?.ticks !== 0) sigs.unshift({ ticks: 0, numerator: 4, denominator: 4 })

  const measures: Measure[] = []
  let tick = 0
  let sigIndex = 0
  do {
    while ((sigs[sigIndex + 1]?.ticks ?? Infinity) <= tick) sigIndex++
    const sig = sigs[sigIndex]!
    const length = (tempoMap.ppq * 4 * sig.numerator) / sig.denominator
    const end = Math.min(tick + length, sigs[sigIndex + 1]?.ticks ?? Infinity)
    measures.push({
      index: measures.length,
      startTick: tick,
      endTick: end,
      startSec: tempoMap.ticksToSeconds(tick),
      endSec: tempoMap.ticksToSeconds(end),
      numerator: sig.numerator,
      denominator: sig.denominator,
    })
    tick = end
  } while (tick < endTick)

  return measures
}

export function measureAtTime(measures: readonly Measure[], sec: number): number {
  let lo = 0
  let hi = measures.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (measures[mid]!.startSec <= sec) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function measureAtTick(measures: readonly Measure[], tick: number): number {
  return Math.max(
    0,
    measures.findLastIndex((m) => m.startTick <= tick),
  )
}
