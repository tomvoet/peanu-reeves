import { CacheStorage, Instrument, type SmplrPreset, type StopFn } from 'smplr'
import type { ToneId } from './tones'

/** Loads a preset written by scripts/fetch-samples.ts from the site's own sample folder. */
const SelfHosted = Instrument<{ url: string }>(async (_ctx, { url }, smplr) => {
  const res = await fetch(`${url}/preset.json`)
  if (!res.ok) throw new Error(`Piano samples missing at ${url} (${res.status})`)
  const preset = (await res.json()) as SmplrPreset
  await smplr.loadInstrument({ ...preset, samples: { ...preset.samples, baseUrl: url } })
})
type SelfHosted = ReturnType<typeof SelfHosted>

interface Voice {
  pitch: number
  stop: StopFn
  /** Key is physically down. */
  held: boolean
}

export interface PianoOptions {
  maxVoices: number
  volume: number
  tone: ToneId
  /** Folder holding one subfolder per tone. */
  samplesUrl: string
}

export interface LoadProgress {
  loaded: number
  total: number
}

/**
 * Live notes start immediately on note-on. Reference parts go through `schedule`.
 * Sustain is handled here so that re-striking and voice stealing stay predictable.
 */
export class Piano {
  private instrument: SelfHosted | null = null
  private readonly voices: Voice[] = []
  private readonly scheduled = new Set<StopFn>()
  private pedalDown = false
  ready: Promise<void> | null = null

  constructor(
    readonly ctx: AudioContext,
    private opts: PianoOptions,
  ) {}

  load(onProgress?: (p: LoadProgress) => void): Promise<void> {
    this.ready ??= this.loadTone(this.opts.tone, onProgress)
    return this.ready
  }

  /** The current tone keeps playing until the new one is ready. */
  setTone(tone: ToneId, onProgress?: (p: LoadProgress) => void): Promise<void> {
    this.opts.tone = tone
    this.ready = this.loadTone(tone, onProgress)
    return this.ready
  }

  private async loadTone(tone: ToneId, onProgress?: (p: LoadProgress) => void): Promise<void> {
    const storage = globalThis.isSecureContext ? CacheStorage() : undefined
    const next = SelfHosted(this.ctx, {
      url: `${this.opts.samplesUrl.replace(/\/$/, '')}/${tone}`,
      volume: this.opts.volume,
      onLoadProgress: onProgress,
      ...(storage && { storage }),
    })
    try {
      await next.ready
    } catch (e) {
      next.dispose()
      throw e
    }
    if (this.opts.tone !== tone) return void next.dispose()

    const previous = this.instrument
    this.instrument = next
    if (previous) {
      this.allNotesOff()
      previous.dispose()
    }
  }

  get loaded(): boolean {
    return this.instrument !== null
  }

  configure(opts: Partial<PianoOptions>): void {
    this.opts = { ...this.opts, ...opts }
    if (this.instrument && opts.volume !== undefined) this.instrument.output.volume = opts.volume
  }

  noteOn(pitch: number, velocity: number): void {
    if (!this.instrument) return

    for (const v of this.voices.filter((v) => v.pitch === pitch)) this.release(v)
    while (this.voices.length >= this.opts.maxVoices) {
      this.release(this.voices.find((v) => !v.held) ?? this.voices[0]!)
    }

    const stop = this.instrument.start({ note: pitch, velocity })
    this.voices.push({ pitch, stop, held: true })
  }

  noteOff(pitch: number): void {
    for (const v of this.voices.filter((v) => v.pitch === pitch && v.held)) {
      v.held = false
      if (!this.pedalDown) this.release(v)
    }
  }

  pedal(cc: number, value: number): void {
    if (cc !== 64) return
    this.pedalDown = value >= 64
    if (!this.pedalDown) for (const v of this.voices.filter((v) => !v.held)) this.release(v)
  }

  /** Plays a reference note at an AudioContext time. */
  schedule(pitch: number, velocity: number, time: number, duration: number): void {
    if (!this.instrument) return
    const stop = this.instrument.start({
      note: pitch,
      velocity,
      time,
      duration,
      onEnded: () => this.scheduled.delete(stop),
    })
    this.scheduled.add(stop)
  }

  stopScheduled(): void {
    for (const stop of this.scheduled) stop()
    this.scheduled.clear()
  }

  allNotesOff(): void {
    this.stopScheduled()
    while (this.voices.length) this.release(this.voices[0]!)
    this.pedalDown = false
  }

  private release(v: Voice): void {
    v.stop()
    this.voices.splice(this.voices.indexOf(v), 1)
  }
}
