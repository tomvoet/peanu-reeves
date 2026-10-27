import { createHooks } from 'hookable'
import type { Unsub } from '../types'
import type { InputEvent } from './remote'

export type NoteOnHandler = (pitch: number, velocity: number, t: number) => void
export type NoteOffHandler = (pitch: number, t: number) => void
export type PedalHandler = (cc: number, value: number, t: number) => void
export type ControlHandler = (cc: number, value: number, t: number) => void

/** Times are in the engine clock domain (AudioContext seconds). */
export interface MidiInput {
  onNoteOn(cb: NoteOnHandler): Unsub
  onNoteOff(cb: NoteOffHandler): Unsub
  onPedal(cb: PedalHandler): Unsub
  /** Other controllers (footswitches, buttons), not used for playing. */
  onControl?(cb: ControlHandler): Unsub
}

interface InputHooks {
  noteOn: NoteOnHandler
  noteOff: NoteOffHandler
  pedal: PedalHandler
  control: ControlHandler
}

export type ClockMapper = (eventTimeStampMs: number) => number

export class InputEmitter implements MidiInput {
  protected readonly hooks = createHooks<InputHooks>()

  onNoteOn(cb: NoteOnHandler): Unsub {
    return this.hooks.hook('noteOn', cb)
  }

  onNoteOff(cb: NoteOffHandler): Unsub {
    return this.hooks.hook('noteOff', cb)
  }

  onPedal(cb: PedalHandler): Unsub {
    return this.hooks.hook('pedal', cb)
  }

  onControl(cb: ControlHandler): Unsub {
    return this.hooks.hook('control', cb)
  }

  protected emitNoteOn(pitch: number, velocity: number, t: number): void {
    void this.hooks.callHook('noteOn', pitch, velocity, t)
  }

  protected emitNoteOff(pitch: number, t: number): void {
    void this.hooks.callHook('noteOff', pitch, t)
  }

  protected emitPedal(cc: number, value: number, t: number): void {
    void this.hooks.callHook('pedal', cc, value, t)
  }

  protected emitControl(cc: number, value: number, t: number): void {
    void this.hooks.callHook('control', cc, value, t)
  }
}

/** Fans in several inputs into one. */
export class InputHub extends InputEmitter {
  private readonly sources = new Map<MidiInput, Unsub[]>()

  /** Sees every event first. Returning true swallows it (used by the piano remote). */
  intercept: ((e: InputEvent) => boolean) | null = null

  add(input: MidiInput): Unsub {
    this.remove(input)

    const take = (e: InputEvent) => this.intercept?.(e) ?? false
    this.sources.set(input, [
      input.onNoteOn((p, v, t) => take({ type: 'noteOn', pitch: p }) || this.emitNoteOn(p, v, t)),
      input.onNoteOff((p, t) => take({ type: 'noteOff', pitch: p }) || this.emitNoteOff(p, t)),
      input.onPedal(
        (c, v, t) => take({ type: 'control', cc: c, value: v }) || this.emitPedal(c, v, t),
      ),
      ...(input.onControl
        ? [
            input.onControl(
              (c, v, t) => take({ type: 'control', cc: c, value: v }) || this.emitControl(c, v, t),
            ),
          ]
        : []),
    ])

    return () => this.remove(input)
  }

  remove(input: MidiInput): void {
    for (const off of this.sources.get(input) ?? []) off()
    this.sources.delete(input)
  }
}
