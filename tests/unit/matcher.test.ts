import { describe, expect, it } from 'vite-plus/test'
import {
  Matcher,
  type ExpectedNote,
  type MatchEvent,
  type MatcherOptions,
  type WaitOptions,
} from '../../engine/matcher/matcher'

const note = (id: string, pitch: number, start: number, measure = 0): ExpectedNote => ({
  id,
  pitch,
  start,
  hand: 'R',
  measure,
})

const scale = [60, 62, 64, 65].map((p, i) => note(`n${i}`, p, i * 0.5, i >> 1))
const chord = [note('c1', 60, 1), note('c2', 64, 1), note('c3', 67, 1)]

const baseOptions: MatcherOptions = { toleranceMs: 150, tempoFactor: 1, offsetMs: 0, wait: null }

/** Plays a synthetic performance. The matcher only ever sees what a real session would feed it. */
function perform(
  notes: ExpectedNote[],
  played: [pitch: number, time: number][],
  opts: Partial<MatcherOptions> = {},
  end = 10,
): MatchEvent[] {
  const m = new Matcher(notes, (t) => Math.floor(t), { ...baseOptions, ...opts })
  const events: MatchEvent[] = []
  for (const [pitch, time] of played.toSorted((a, b) => a[1] - b[1])) {
    events.push(...m.advance(time), m.noteOn(pitch, time))
  }
  events.push(...m.advance(end), ...m.flush())
  return events
}

const count = (events: MatchEvent[], type: MatchEvent['type']) =>
  events.filter((e) => e.type === type).length

const deviations = (events: MatchEvent[]) =>
  events.flatMap((e) => (e.type === 'hit' ? [Math.round(e.deviationMs)] : []))

describe('Matcher', () => {
  it('scores a perfect performance', () => {
    const events = perform(
      scale,
      scale.map((n) => [n.pitch, n.start]),
    )
    expect(count(events, 'hit')).toBe(4)
    expect(deviations(events)).toEqual([0, 0, 0, 0])
  })

  it('reports a rushed performance as early', () => {
    const events = perform(
      scale,
      scale.map((n) => [n.pitch, n.start - 0.08]),
    )
    expect(deviations(events)).toEqual([-80, -80, -80, -80])
  })

  it('reports a dragged performance as late', () => {
    const events = perform(
      scale,
      scale.map((n, i) => [n.pitch, n.start + 0.03 * (i + 1)]),
    )
    expect(deviations(events)).toEqual([30, 60, 90, 120])
  })

  it('misses notes played outside the window and flags them as wrong', () => {
    const events = perform(scale, [[60, 0.2]])
    expect(count(events, 'hit')).toBe(0)
    expect(count(events, 'wrong')).toBe(1)
    expect(count(events, 'miss')).toBe(4)
  })

  it('matches chord notes in any order', () => {
    const events = perform(chord, [
      [67, 1.0],
      [60, 1.01],
      [64, 1.005],
    ])
    expect(count(events, 'hit')).toBe(3)
  })

  it('matches a rolled chord', () => {
    const events = perform(chord, [
      [60, 0.95],
      [64, 1.02],
      [67, 1.11],
    ])
    expect(count(events, 'hit')).toBe(3)
    expect(deviations(events)).toEqual([-50, 20, 110])
  })

  it('classifies wrong pitches and missed notes', () => {
    const events = perform(chord, [
      [60, 1],
      [65, 1],
    ])
    expect(count(events, 'hit')).toBe(1)
    expect(count(events, 'wrong')).toBe(1)
    expect(count(events, 'miss')).toBe(2)
    const wrong = events.find((e) => e.type === 'wrong')
    expect(wrong).toMatchObject({ pitch: 65, measure: 1 })
  })

  it('pairs repeated pitches with the closest expected note', () => {
    const repeated = [note('a', 60, 0), note('b', 60, 0.2)]
    const events = perform(repeated, [
      [60, 0.19],
      [60, 0.01],
    ])
    expect(
      events.filter((e) => e.type === 'hit').map((e) => e.type === 'hit' && e.note.id),
    ).toEqual(['a', 'b'])
  })

  it('emits misses only once their window has passed', () => {
    const m = new Matcher(scale, () => 0, baseOptions)
    expect(m.advance(0.14)).toEqual([])
    expect(m.advance(0.16).map((e) => e.type)).toEqual(['miss'])
  })

  it('scales the window with tempo and reports real-time deviation', () => {
    // The window is fixed in song time, so at half speed it spans ±300 ms of real time.
    const slow = perform([note('a', 60, 1)], [[60, 1.1]], { tempoFactor: 0.5 })
    expect(deviations(slow)).toEqual([200])
    const tooLate = perform([note('a', 60, 1)], [[60, 1.2]], { tempoFactor: 0.5 })
    expect(count(tooLate, 'hit')).toBe(0)
  })

  it('applies the calibration offset', () => {
    const events = perform(
      scale,
      scale.map((n) => [n.pitch, n.start + 0.12]),
      { offsetMs: 120 },
    )
    expect(deviations(events)).toEqual([0, 0, 0, 0])
    const hit = events.find((e) => e.type === 'hit')
    expect(hit?.type === 'hit' && hit.time).toBeCloseTo(0)
  })

  describe('wait mode', () => {
    const wait = (
      chordMode: WaitOptions['chord'],
      wrongBlocks = false,
    ): Partial<MatcherOptions> => ({
      wait: { chord: chordMode, wrongBlocks },
    })

    it('never times out notes and holds at the next chord', () => {
      const m = new Matcher(chord, () => 0, { ...baseOptions, ...wait('all') })
      expect(m.advance(5)).toEqual([])
      expect(m.holdPoint()).toBe(1)
      m.noteOn(60, 1)
      m.noteOn(64, 1)
      expect(m.holdPoint()).toBe(1)
      m.noteOn(67, 1)
      expect(m.holdPoint()).toBeNull()
    })

    it('can wait for one hand while the other is scored in time', () => {
      const left: ExpectedNote = { ...note('l1', 48, 1), hand: 'L' }
      const right = note('r1', 72, 2)
      const m = new Matcher([left, right], () => 0, {
        ...baseOptions,
        wait: { chord: 'all', wrongBlocks: false, hands: ['R'] },
      })
      expect(m.holdPoint()).toBe(2)
      expect(m.currentChord()).toEqual([right])
      expect(m.advance(1.5)).toEqual([{ type: 'miss', note: left }])
      expect(m.advance(9)).toEqual([])
      expect(m.noteOn(72, 2).type).toBe('hit')
      expect(m.holdPoint()).toBeNull()
    })

    it('accepts chord notes despite a large input offset while halted', () => {
      const m = new Matcher(chord, () => 0, { ...baseOptions, ...wait('all'), offsetMs: 400 })
      expect(m.noteOn(60, 1).type).toBe('hit')
    })

    it('releases the whole chord on any note in "any" mode', () => {
      const m = new Matcher([...chord, note('next', 72, 2)], () => 0, {
        ...baseOptions,
        ...wait('any'),
      })
      expect(m.noteOn(64, 1).type).toBe('hit')
      expect(m.holdPoint()).toBe(2)
      expect(m.flush(1.5)).toEqual([])
    })

    it('keeps blocking while a wrong key is held when configured', () => {
      const m = new Matcher(chord, () => 0, { ...baseOptions, ...wait('all', true) })
      expect(m.noteOn(61, 1).type).toBe('wrong')
      expect(m.blockedByWrongNotes()).toBe(true)
      m.noteOff(61)
      expect(m.blockedByWrongNotes()).toBe(false)

      const lenient = new Matcher(chord, () => 0, { ...baseOptions, ...wait('all', false) })
      lenient.noteOn(61, 1)
      expect(lenient.blockedByWrongNotes()).toBe(false)
    })

    it('does not accept the next chord far ahead of time', () => {
      const m = new Matcher([note('a', 60, 0), note('b', 62, 2)], () => 0, {
        ...baseOptions,
        ...wait('all'),
      })
      m.noteOn(60, 0)
      expect(m.noteOn(62, 0.5).type).toBe('wrong')
    })
  })
})
