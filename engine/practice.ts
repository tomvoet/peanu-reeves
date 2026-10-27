import { createHooks } from 'hookable'
import { scheduleClick } from './audio/click'
import type { Piano } from './audio/piano'
import { Transport, type LoopRange } from './clock/transport'
import { Matcher, type ExpectedNote, type MatchEvent, type WaitOptions } from './matcher/matcher'
import type { MidiInput } from './midi-input/types'
import { DEFAULT_HAND_MODES, isAutoPlayed, isExpected, isVisible } from './modes/hands'
import { measureRangeToLoop, type MeasureRange } from './modes/loop'
import {
  advanceRamp,
  DEFAULT_TEMPO_RAMP,
  startRamp,
  type RampState,
  type TempoRampConfig,
} from './modes/tempo-ramp'
import {
  alignTake,
  type AlignedNote,
  type Interval,
  type TakeEvent,
  type TakeNote,
} from './recording/take'
import { Renderer, type KeyState, type NoteResult, type RenderFrame } from './render/renderer'
import { StaffRenderer } from './render/staff'

export type { ReplayFrame } from './render/renderer'
import { measureAtTime } from './song/measures'
import {
  aggregatePass,
  accuracyOf,
  emptyCounts,
  type NoteCounts,
  type PassStats,
} from './stats/aggregate'
import type { HandModes, Song, Unsub } from './types'

export interface PracticeConfig {
  handModes: HandModes
  tempo: number
  toleranceMs: number
  offsetMs: number
  wait: WaitOptions | null
  loop: MeasureRange | null
  ramp: TempoRampConfig
  lookahead: number
  /** Off in listen mode: input is ignored and no passes are reported. */
  scoring: boolean
  /** Ramp tempo to resume from when a ramp (re)starts, e.g. saved progress for this loop. */
  rampFrom: number | null
  /** Bars of clicks before playback starts. */
  countIn: number
  metronome: boolean
  /** Replaying a recorded take instead of practising. Nothing is scored meanwhile. */
  replay: Replay | null
}

export type ReplayMode = 'you' | 'score' | 'both'

export interface Replay {
  /** What was played, in song seconds. */
  readonly notes: readonly TakeNote[]
  readonly pedal: readonly Interval[]
  /** Tempo the take was played at, for timing deviations. */
  readonly tempo: number
  readonly from: number
  readonly to: number
  readonly mode: ReplayMode
  /** Compare against another take instead of the score. */
  readonly reference: readonly TakeNote[] | null
}

export interface RecordedTake {
  readonly events: TakeEvent[]
  /** Song seconds the take covers. */
  readonly fromSec: number
  readonly toSec: number
}

export const DEFAULT_PRACTICE_CONFIG: PracticeConfig = {
  handModes: DEFAULT_HAND_MODES,
  tempo: 1,
  toleranceMs: 150,
  offsetMs: 0,
  wait: null,
  loop: null,
  ramp: DEFAULT_TEMPO_RAMP,
  lookahead: 3,
  scoring: true,
  rampFrom: null,
  countIn: 0,
  metronome: false,
  replay: null,
}

export interface PassResult extends PassStats {
  startedAt: number
  tempo: number
  loop: MeasureRange | null
  handModes: HandModes
  wait: boolean
  /** Timing of every hit in real ms (negative = early), for the timing histogram. */
  deviations: number[]
  /** Everything played during the pass, to listen back to. */
  take: RecordedTake
}

/** A pass that was cut short but long enough to keep as a take. */
export interface PartialTake extends RecordedTake {
  startedAt: number
  tempo: number
  loop: MeasureRange | null
  accuracy: number | null
}

export interface SessionStatus {
  playing: boolean
  countingIn: boolean
  ramp: RampState | null
  waiting: boolean
  songTime: number
  tempo: number
  counts: NoteCounts
  accuracy: number | null
  lastDeviationMs: number | null
  replaying: boolean
}

interface SessionHooks {
  pass: (result: PassResult) => void
  /** A pass ended without a single key played, so it is not scored. */
  idle: () => void
  match: (event: MatchEvent) => void
  tempo: (tempo: number) => void
  partialTake: (take: PartialTake) => void
  /** A replay reached its end and rewound. */
  replayEnd: () => void
}

/** Something the session can schedule on the piano: a score note or a played note. */
interface Playable {
  readonly pitch: number
  readonly startSec: number
  readonly endSec: number
  readonly velocity: number
}

interface Beat {
  time: number
  /** First beat of a bar, clicked with an accent. */
  down: boolean
}

interface WrongNote {
  pitch: number
  time: number
}

/** Real seconds of auto-played notes and clicks handed to the audio clock in advance. */
const SCHEDULE_AHEAD = 0.2
/** A pass cut short is kept as a take once it ran at least this many real seconds. */
const PARTIAL_TAKE_SEC = 30

export class PracticeSession {
  readonly hooks = createHooks<SessionHooks>()
  readonly transport: Transport
  private config: PracticeConfig
  private matcher!: Matcher
  private events: MatchEvent[] = []
  private counts: NoteCounts = emptyCounts()
  private lastDeviationMs: number | null = null
  private results = new Map<string, NoteResult>()
  private wrongs: WrongNote[] = []
  private readonly pressed = new Map<number, KeyState>()
  private autoNotes: readonly Playable[] = []
  private autoIndex = 0
  private playing = false
  private waiting = false
  private passStartedAt = Date.now()
  private ramp: RampState | null = null
  private renderer: Renderer | null = null
  private staff: StaffRenderer | null = null
  private raf = 0
  private readonly unsubs: Unsub[] = []
  private readonly beats: readonly Beat[]
  private beatIndex = 0
  private readonly clicks = new Set<() => void>()
  /** Song time where the music resumes after a count-in. */
  private countInUntil: number | null = null
  /** Input recorded during the current pass. */
  private take: TakeEvent[] = []
  private passFrom = 0
  private passCompleted = false
  private readonly pedals = new Map<number, number>()
  private replayAligned: readonly AlignedNote[] = []

  constructor(
    readonly song: Song,
    private readonly piano: Piano,
    input: MidiInput,
    config: Partial<PracticeConfig> = {},
    now: () => number = () => piano.ctx.currentTime,
  ) {
    this.config = { ...DEFAULT_PRACTICE_CONFIG, ...config }
    this.transport = new Transport(now)
    this.transport.tempo = this.config.tempo

    this.unsubs.push(
      input.onNoteOn((p, v, t) => this.handleNoteOn(p, v, t)),
      input.onNoteOff((p, t) => this.handleNoteOff(p, t)),
      input.onPedal((cc, v, t) => this.handlePedal(cc, v, t)),
    )

    this.beats = song.measures.flatMap((m) => {
      const beat = (m.endSec - m.startSec) / m.numerator
      return Array.from({ length: m.numerator }, (_, i) => ({
        time: m.startSec + i * beat,
        down: i === 0,
      }))
    })

    this.applyLoop()
    if (this.config.ramp.enabled && this.config.loop) {
      this.ramp = startRamp(this.config.ramp, this.config.rampFrom)
      this.transport.tempo = this.ramp.tempo
    }
    this.resetPass(this.loopRange?.start ?? 0)
  }

  attach(canvas: HTMLCanvasElement): Renderer {
    this.renderer = new Renderer(canvas, { lookahead: this.config.lookahead })

    const loop = () => {
      this.frame()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
    return this.renderer
  }

  /** Draws a scrolling grand staff on a second canvas, in step with the falling notes. */
  attachStaff(canvas: HTMLCanvasElement): StaffRenderer {
    this.staff = new StaffRenderer(canvas, this.song)
    return this.staff
  }

  detachStaff(): void {
    this.staff = null
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    this.piano.allNotesOff()
    this.stopClicks()
    for (const off of this.unsubs) off()
    this.piano.stopScheduled()
    this.hooks.removeAllHooks()
  }

  get status(): SessionStatus {
    return {
      playing: this.playing,
      ramp: this.ramp,
      countingIn: this.countInUntil !== null && this.transport.songTime() < this.countInUntil,
      waiting: this.waiting,
      songTime: this.transport.songTime(),
      tempo: this.transport.tempo,
      counts: this.counts,
      accuracy: accuracyOf(this.counts),
      lastDeviationMs: this.lastDeviationMs,
      replaying: !!this.config.replay,
    }
  }

  get settings(): Readonly<PracticeConfig> {
    return this.config
  }

  play(): void {
    if (this.playing) return

    const end = this.loopRange?.end ?? this.song.durationSec
    if (this.transport.songTime() >= end) this.seek(this.loopRange?.start ?? 0)
    void this.piano.ctx.resume()
    this.playing = true

    const from = this.transport.songTime()
    const m = this.song.measures[measureAtTime(this.song.measures, from)]
    const perBar = m?.numerator ?? 4
    const beat = m ? (m.endSec - m.startSec) / perBar : 0.5
    const total = this.config.countIn * perBar
    if (total > 0) {
      this.countInUntil = from
      this.transport.seek(from - total * beat)
    }

    // Notes and clicks cut off by the last pause are scheduled again.
    this.rescheduleAuto()
    this.transport.play()
    for (let i = 0; i < total; i++) {
      this.addClick(this.transport.ctxTimeAt(from - (total - i) * beat), i % perBar === 0)
    }
  }

  pause(): void {
    if (!this.playing) return

    this.playing = false
    this.waiting = false
    this.transport.pause()
    if (this.countInUntil !== null && this.transport.songTime() < this.countInUntil)
      this.transport.seek(this.countInUntil)
    this.countInUntil = null
    this.piano.stopScheduled()
    this.stopClicks()
  }

  toggle(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  seek(songSec: number): void {
    const replay = this.config.replay
    const range = replay ? { start: replay.from, end: replay.to } : this.loopRange
    this.countInUntil = null
    const t = range ? Math.min(Math.max(songSec, range.start), range.end) : songSec
    this.transport.seek(Math.min(Math.max(0, t), this.song.durationSec))

    // While waiting the transport stays held. The next frame releases it if nothing is due here.
    this.piano.stopScheduled()
    this.resetPass(this.transport.songTime())
  }

  setTempo(tempo: number): void {
    this.transport.setTempo(tempo)
    this.matcher.setTempo(tempo)
    this.config.tempo = tempo
    this.rescheduleAuto()
    void this.hooks.callHook('tempo', tempo)
  }

  get rampTempo(): number | null {
    return this.ramp?.tempo ?? null
  }

  update(patch: Partial<PracticeConfig>): void {
    const prev = this.config
    this.config = { ...prev, ...patch }

    if (patch.lookahead !== undefined && this.renderer)
      this.renderer.options.lookahead = patch.lookahead
    if (patch.tempo !== undefined && patch.tempo !== this.transport.tempo)
      this.setTempo(patch.tempo)

    const rampChanged =
      patch.ramp &&
      (patch.ramp.enabled !== prev.ramp.enabled || patch.ramp.start !== prev.ramp.start)
    if (rampChanged || (patch.loop !== undefined && this.config.ramp.enabled)) {
      this.ramp = this.config.ramp.enabled
        ? startRamp(this.config.ramp, this.config.rampFrom)
        : null
      if (this.ramp) this.setTempo(this.ramp.tempo)
    }

    if (patch.replay !== undefined) {
      this.replayAligned = patch.replay
        ? alignTake(patch.replay.notes, this.song.notes, patch.replay.tempo)
        : []
      const entering = !prev.replay && patch.replay
      this.applyLoop()
      this.seek(entering && patch.replay ? patch.replay.from : this.transport.songTime())
    } else if (patch.loop !== undefined) {
      this.applyLoop()
      this.seek(this.loopRange?.start ?? this.transport.songTime())
    } else if (
      patch.handModes ||
      patch.wait !== undefined ||
      patch.scoring !== undefined ||
      patch.toleranceMs !== undefined ||
      patch.offsetMs !== undefined
    ) {
      this.seek(this.transport.songTime())
    }
  }

  private get loopRange(): LoopRange | null {
    return this.transport.loop
  }

  private applyLoop(): void {
    this.transport.loop =
      this.config.loop && !this.config.replay
        ? measureRangeToLoop(this.song.measures, this.config.loop)
        : null
  }

  private get scoring(): boolean {
    return this.config.scoring && !this.config.replay
  }

  private resetPass(from: number): void {
    this.keepPartialTake()

    const until = this.loopRange?.end ?? Infinity
    const expected: ExpectedNote[] = this.song.notes
      .filter(
        (n) =>
          this.scoring &&
          isExpected(n, this.config.handModes) &&
          n.startSec >= from - 1e-6 &&
          n.startSec < until,
      )
      .map((n) => ({
        id: n.id,
        pitch: n.pitch,
        start: n.startSec,
        hand: n.hand,
        measure: n.measure,
      }))

    this.matcher = new Matcher(expected, (t) => measureAtTime(this.song.measures, t), {
      toleranceMs: this.config.toleranceMs,
      tempoFactor: this.transport.tempo,
      offsetMs: this.config.offsetMs,
      wait: this.config.wait,
    })
    this.events = []
    this.counts = emptyCounts()
    this.results = new Map()
    this.wrongs = []
    this.lastDeviationMs = null
    this.passStartedAt = Date.now()
    this.passFrom = from
    this.passCompleted = false
    // A sustain pedal held across a loop restart counts from the start of the new take.
    this.take = Array.from(this.pedals, ([cc, value]) => ({ kind: 'pedal', t: from, cc, value }))

    this.autoNotes = this.playlist()
    this.rescheduleAuto()
  }

  /** What the piano plays by itself: auto hands, or the take / reference while replaying. */
  private playlist(): readonly Playable[] {
    const replay = this.config.replay
    if (!replay) return this.song.notes.filter((n) => isAutoPlayed(n, this.config.handModes))

    const fromTake = (notes: readonly TakeNote[]): Playable[] =>
      notes.map((n) => ({
        pitch: n.pitch,
        startSec: n.start,
        endSec: n.soundEnd,
        velocity: n.velocity,
      }))
    if (replay.mode !== 'score') return fromTake(replay.notes)
    if (replay.reference) return fromTake(replay.reference)
    return this.song.notes.filter((n) => isVisible(n, this.config.handModes))
  }

  /** Keeps a pass that was cut short (seek, restart) as a take if it ran long enough. */
  private keepPartialTake(): void {
    if (this.passCompleted || !this.scoring || !this.take.some((e) => e.kind === 'on')) return

    const to = this.transport.songTime()
    const realSec = (to - this.passFrom) / this.transport.tempo
    if (realSec < PARTIAL_TAKE_SEC) return

    void this.hooks.callHook('partialTake', {
      events: this.take,
      fromSec: this.passFrom,
      toSec: to,
      startedAt: this.passStartedAt,
      tempo: this.transport.tempo,
      loop: this.config.loop,
      accuracy: accuracyOf(this.counts),
    })
  }

  private rescheduleAuto(): void {
    this.piano.stopScheduled()
    this.stopClicks()

    const t = Math.max(this.transport.songTime(), this.countInUntil ?? -Infinity)
    this.autoIndex = this.autoNotes.findIndex((n) => n.startSec >= t - 1e-6)
    if (this.autoIndex < 0) this.autoIndex = this.autoNotes.length
    this.beatIndex = this.beats.findIndex((b) => b.time >= t - 1e-6)
    if (this.beatIndex < 0) this.beatIndex = this.beats.length
  }

  private addClick(at: number, accent: boolean): void {
    const stop = scheduleClick(this.piano.ctx, Math.max(this.piano.ctx.currentTime, at), accent)
    this.clicks.add(stop)
    setTimeout(
      () => this.clicks.delete(stop),
      Math.max(0, at - this.piano.ctx.currentTime) * 1000 + 200,
    )
  }

  private stopClicks(): void {
    for (const stop of this.clicks) stop()
    this.clicks.clear()
  }

  private record(e: MatchEvent): void {
    this.events.push(e)
    this.counts[e.type]++
    if (e.type === 'hit') {
      this.results.set(e.note.id, { type: 'hit', time: e.time, deviationMs: e.deviationMs })
      this.lastDeviationMs = e.deviationMs
    } else if (e.type === 'miss') {
      this.results.set(e.note.id, { type: 'miss' })
    } else {
      this.wrongs.push({ pitch: e.pitch, time: e.time })
      if (this.wrongs.length > 200) this.wrongs.shift()
    }
    void this.hooks.callHook('match', e)
  }

  private handleNoteOn(pitch: number, velocity: number, t: number): void {
    if (!this.playing || !this.scoring) {
      this.pressed.set(pitch, 'free')
      return
    }

    const at = this.transport.songTime(t)
    this.take.push({ kind: 'on', t: at, pitch, velocity })
    const e = this.matcher.noteOn(pitch, at)
    this.pressed.set(pitch, e.type === 'hit' ? 'ok' : 'wrong')
    this.record(e)
  }

  private handleNoteOff(pitch: number, t: number): void {
    this.pressed.delete(pitch)
    this.matcher.noteOff(pitch)
    if (this.playing && this.scoring) {
      this.take.push({ kind: 'off', t: this.transport.songTime(t), pitch })
    }
  }

  private handlePedal(cc: number, value: number, t: number): void {
    this.pedals.set(cc, value)
    if (this.playing && this.scoring) {
      this.take.push({ kind: 'pedal', t: this.transport.songTime(t), cc, value })
    }
  }

  private completePass(until: number): void {
    this.passCompleted = true
    for (const e of this.matcher.flush(until)) this.record(e)

    if (!this.events.length) return
    if (this.counts.hit + this.counts.wrong === 0) {
      void this.hooks.callHook('idle')
      return
    }

    const range = this.config.loop
    const measures = this.song.measures
      .filter((m) => (range ? m.index >= range.startMeasure && m.index <= range.endMeasure : true))
      .map((m) => m.index)
    const stats = aggregatePass(this.events, measures)
    const result: PassResult = {
      ...stats,
      startedAt: this.passStartedAt,
      tempo: this.transport.tempo,
      loop: range,
      handModes: { ...this.config.handModes },
      wait: !!this.config.wait,
      deviations: this.events.flatMap((e) => (e.type === 'hit' ? [e.deviationMs] : [])),
      take: {
        events: this.take,
        fromSec: this.passFrom,
        toSec: Number.isFinite(until) ? until : this.song.durationSec,
      },
    }
    void this.hooks.callHook('pass', result)

    if (this.ramp && range && stats.accuracy !== null) {
      this.ramp = advanceRamp(this.config.ramp, this.ramp, stats.accuracy)
      if (this.ramp.tempo !== this.transport.tempo) this.setTempo(this.ramp.tempo)
    }
  }

  private frame(): void {
    if (this.playing) this.step()
    const frame: RenderFrame = {
      songTime: this.transport.songTime(),
      tempo: this.transport.tempo,
      notes: this.song.notes,
      measures: this.song.measures,
      handModes: this.config.handModes,
      results: this.results,
      wrongs: this.wrongs,
      pressed: this.pressed,
      loop: this.loopRange,
      waiting: this.waiting,
      replay: this.config.replay
        ? {
            mode: this.config.replay.mode,
            notes: this.replayAligned,
            pedal: this.config.replay.pedal,
            reference: this.config.replay.reference,
          }
        : null,
    }
    this.renderer?.draw(frame)
    this.staff?.draw(frame)
  }

  private step(): void {
    const range = this.loopRange
    if (range && this.transport.tick()) {
      this.completePass(range.end)
      this.resetPass(range.start)
    }

    const hold = this.matcher.holdPoint()
    if (this.waiting) {
      if (
        (hold === null || hold > this.transport.songTime()) &&
        !this.matcher.blockedByWrongNotes()
      ) {
        this.waiting = false
        this.transport.play()
      } else return
    } else if (hold !== null && this.transport.songTime() >= hold) {
      this.transport.pause()
      this.transport.seek(hold)
      this.waiting = true
      return
    }

    const t = this.transport.songTime()
    if (this.countInUntil !== null && t >= this.countInUntil) this.countInUntil = null
    for (const e of this.matcher.advance(t)) this.record(e)
    this.scheduleAuto(t, hold)
    if (this.config.metronome) this.scheduleBeats(t, hold)

    const replay = this.config.replay
    if (replay) {
      if (t >= replay.to + 0.3) {
        this.pause()
        this.seek(replay.from)
        void this.hooks.callHook('replayEnd')
      }
      return
    }

    if (!range && t >= this.song.durationSec + 0.3) {
      this.completePass(Infinity)
      this.pause()
      this.transport.seek(0)
      this.resetPass(0)
    }
  }

  private scheduleBeats(t: number, hold: number | null): void {
    let horizon = t + SCHEDULE_AHEAD * this.transport.tempo
    if (hold !== null) horizon = Math.min(horizon, hold - 1e-6)
    if (this.loopRange) horizon = Math.min(horizon, this.loopRange.end - 1e-6)

    while (this.beatIndex < this.beats.length) {
      const b = this.beats[this.beatIndex]!
      if (b.time >= horizon) break
      this.beatIndex++
      if (b.time < t - 0.05) continue
      this.addClick(this.transport.ctxTimeAt(b.time), b.down)
    }
  }

  private scheduleAuto(t: number, hold: number | null): void {
    let horizon = t + SCHEDULE_AHEAD * this.transport.tempo
    if (hold !== null) horizon = Math.min(horizon, hold - 1e-6)
    if (this.loopRange) horizon = Math.min(horizon, this.loopRange.end)
    if (this.config.replay) horizon = Math.min(horizon, this.config.replay.to + 0.3)

    const now = this.piano.ctx.currentTime
    while (this.autoIndex < this.autoNotes.length) {
      const n = this.autoNotes[this.autoIndex]!
      if (n.startSec >= horizon) break
      this.autoIndex++
      if (n.startSec < t - 0.05) continue
      const at = Math.max(now, this.transport.ctxTimeAt(n.startSec))
      this.piano.schedule(n.pitch, n.velocity, at, (n.endSec - n.startSec) / this.transport.tempo)
    }
  }
}
