import { Piano, type PianoOptions } from './audio/piano'
import { createAudioClock, type AudioClock } from './clock/audio-clock'
import { KeyboardInput } from './midi-input/keyboard'
import { RemoteControl } from './midi-input/remote'
import { InputHub } from './midi-input/types'
import { WebMidiInput } from './midi-input/web-midi'

export interface LatencyInfo {
  base: number
  output: number
  sampleRate: number
}

/** Audio + input plumbing shared by every page. Live notes are routed straight to the piano here. */
export class Runtime {
  readonly ctx: AudioContext
  readonly clock: AudioClock
  readonly piano: Piano
  readonly input = new InputHub()
  readonly remote = new RemoteControl()
  readonly keyboard: KeyboardInput
  readonly midi: WebMidiInput

  constructor(opts: PianoOptions) {
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    this.piano = new Piano(this.ctx, opts)
    this.clock = createAudioClock(this.ctx)

    this.keyboard = new KeyboardInput(this.clock.fromPerf)
    this.midi = new WebMidiInput(this.clock.fromPerf)
    this.input.intercept = this.remote.intercept
    this.input.add(this.midi)

    this.input.onNoteOn((pitch, velocity) => {
      if (this.ctx.state !== 'running') void this.ctx.resume()
      this.piano.noteOn(pitch, velocity)
    })
    this.input.onNoteOff((pitch) => this.piano.noteOff(pitch))
    this.input.onPedal((cc, value) => this.piano.pedal(cc, value))
  }

  setKeyboardEnabled(enabled: boolean): void {
    if (enabled) {
      this.keyboard.attach(window)
      this.input.add(this.keyboard)
    } else {
      this.keyboard.detach()
      this.input.remove(this.keyboard)
    }
  }

  get latency(): LatencyInfo {
    return {
      base: this.ctx.baseLatency,
      output: this.ctx.outputLatency,
      sampleRate: this.ctx.sampleRate,
    }
  }
}
