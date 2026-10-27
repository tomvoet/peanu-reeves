import { describe, expect, it } from 'vite-plus/test'
import { Transport } from '../../engine/clock/transport'
import type { ExpectedNote, MatchEvent } from '../../engine/matcher/matcher'
import { measureRangeToLoop } from '../../engine/modes/loop'
import { planDrill } from '../../engine/modes/drill'
import { advanceRamp, startRamp, type TempoRampConfig } from '../../engine/modes/tempo-ramp'
import { parseSong } from '../../engine/song/parse'
import { aggregatePass, worstMeasures } from '../../engine/stats/aggregate'
import { minuet } from '../fixtures/midis'

describe('tempo ramp', () => {
  const config: TempoRampConfig = {
    enabled: true,
    start: 0.6,
    step: 0.1,
    cleanPasses: 2,
    target: 0.8,
    threshold: 0.9,
    failPasses: 2,
  }

  it('steps up after N clean passes and caps at the target', () => {
    let s = startRamp(config)
    const tempos: number[] = []
    for (const acc of [1, 1, 0.95, 0.95, 1, 1, 1]) {
      s = advanceRamp(config, s, acc)
      tempos.push(s.tempo)
    }
    expect(tempos).toEqual([0.6, 0.7, 0.7, 0.8, 0.8, 0.8, 0.8])
  })

  it('resets the clean streak on a sloppy pass', () => {
    let s = startRamp(config)
    s = advanceRamp(config, s, 1)
    s = advanceRamp(config, s, 0.5)
    s = advanceRamp(config, s, 1)
    expect(s).toEqual({ tempo: 0.6, cleanStreak: 1, failStreak: 0 })
  })

  it('steps down after N failed passes, never below the start', () => {
    let s = startRamp(config, 0.8)
    const tempos: number[] = []
    for (const acc of [0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 0.5]) {
      s = advanceRamp(config, s, acc)
      tempos.push(s.tempo)
    }
    expect(tempos).toEqual([0.8, 0.7, 0.7, 0.7, 0.7, 0.6, 0.6, 0.6])
    expect(advanceRamp({ ...config, failPasses: 0 }, startRamp(config, 0.8), 0).tempo).toBe(0.8)
  })

  it('never starts above the target', () => {
    expect(startRamp({ ...config, start: 1.2 }).tempo).toBe(0.8)
    expect(startRamp(config, 0.7).tempo).toBe(0.7)
    expect(startRamp(config, 0.1).tempo).toBe(config.start)
  })
})

describe('Transport', () => {
  it('maps clock time to song time with tempo, seek and loop', () => {
    let now = 10
    const t = new Transport(() => now)
    t.play()
    now = 12
    expect(t.songTime()).toBeCloseTo(2)
    t.setTempo(0.5)
    now = 14
    expect(t.songTime()).toBeCloseTo(3)
    expect(t.ctxTimeAt(4)).toBeCloseTo(16)
    t.pause()
    now = 20
    expect(t.songTime()).toBeCloseTo(3)
    t.loop = { start: 1, end: 3.5 }
    t.play()
    now = 21
    expect(t.tick()).toBe(true)
    expect(t.songTime()).toBeCloseTo(1)
  })

  it('maps a measure range to a loop', () => {
    const song = parseSong(minuet())
    const loop = measureRangeToLoop(song.measures, { startMeasure: 3, endMeasure: 1 })
    expect(loop.start).toBeCloseTo(song.measures[1]!.startSec)
    expect(loop.end).toBeCloseTo(song.measures[3]!.endSec)
  })
})

describe('per-measure aggregation', () => {
  const n = (id: string, measure: number): ExpectedNote => ({
    id,
    pitch: 60,
    start: 0,
    hand: 'R',
    measure,
  })
  const events: MatchEvent[] = [
    { type: 'hit', note: n('a', 0), time: 0, deviationMs: -20 },
    { type: 'hit', note: n('b', 0), time: 0, deviationMs: 20 },
    { type: 'hit', note: n('c', 1), time: 0, deviationMs: 50 },
    { type: 'miss', note: n('d', 1) },
    { type: 'wrong', pitch: 61, time: 0, measure: 2 },
    { type: 'miss', note: n('e', 2) },
  ]

  it('aggregates accuracy and timing per measure', () => {
    const stats = aggregatePass(events, [0, 1, 2, 3])
    expect(stats.notes).toEqual({ hit: 3, wrong: 1, miss: 2 })
    expect(stats.accuracy).toBeCloseTo(0.5)
    expect(stats.meanDevMs).toBeCloseTo(50 / 3)
    expect(stats.perMeasure).toEqual([
      { measure: 0, hit: 2, wrong: 0, miss: 0, accuracy: 1, meanDevMs: 0, stdDevMs: 20 },
      { measure: 1, hit: 1, wrong: 0, miss: 1, accuracy: 0.5, meanDevMs: 50, stdDevMs: 0 },
      { measure: 2, hit: 0, wrong: 1, miss: 1, accuracy: 0, meanDevMs: null, stdDevMs: null },
      { measure: 3, hit: 0, wrong: 0, miss: 0, accuracy: null, meanDevMs: null, stdDevMs: null },
    ])
  })

  it('finds the worst run of measures', () => {
    const stats = aggregatePass(events, [0, 1, 2, 3])
    expect(worstMeasures(stats.perMeasure, 2)).toEqual({ startMeasure: 1, endMeasure: 2 })
    expect(worstMeasures(stats.perMeasure, 1)).toEqual({ startMeasure: 2, endMeasure: 2 })
  })

  it('returns null for a clean pass', () => {
    const clean = aggregatePass([{ type: 'hit', note: n('a', 0), time: 0, deviationMs: 0 }], [0])
    expect(worstMeasures(clean.perMeasure)).toBeNull()
  })
})

describe('planDrill', () => {
  const bars = (accs: (number | null)[]) => accs.map((accuracy, measure) => ({ measure, accuracy }))

  it('pads weak bars by one bar and orders by the worst bar', () => {
    const plan = planDrill(bars([1, 0.5, 1, 1, 1, 1, 0.2, 1, 1, null]), 10, 0.9)
    expect(plan).toEqual([
      { startMeasure: 5, endMeasure: 7, worst: 0.2 },
      { startMeasure: 0, endMeasure: 2, worst: 0.5 },
    ])
  })

  it('merges weak bars whose loops would touch, up to a span limit', () => {
    expect(planDrill(bars([1, 0.5, 1, 0.6, 1]), 5, 0.9)).toEqual([
      { startMeasure: 0, endMeasure: 4, worst: 0.5 },
    ])
    expect(planDrill(bars([0.1, 0.1, 0.1, 0.1, 0.1, 0.1]), 6, 0.9)).toHaveLength(2)
  })

  it('returns nothing when every bar is clean', () => {
    expect(planDrill(bars([1, 0.95, null]), 3, 0.9)).toEqual([])
  })
})
