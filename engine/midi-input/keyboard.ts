import { InputEmitter, type ClockMapper } from './types'

// Two rows of a piano laid over the keyboard, by physical key position.
const LOWER: readonly string[] = [
  'KeyZ',
  'KeyS',
  'KeyX',
  'KeyD',
  'KeyC',
  'KeyV',
  'KeyG',
  'KeyB',
  'KeyH',
  'KeyN',
  'KeyJ',
  'KeyM',
  'Comma',
  'KeyL',
  'Period',
  'Semicolon',
  'Slash',
]
const UPPER: readonly string[] = [
  'KeyQ',
  'Digit2',
  'KeyW',
  'Digit3',
  'KeyE',
  'KeyR',
  'Digit5',
  'KeyT',
  'Digit6',
  'KeyY',
  'Digit7',
  'KeyU',
  'KeyI',
  'Digit9',
  'KeyO',
  'Digit0',
  'KeyP',
  'BracketLeft',
  'Equal',
  'BracketRight',
]

export const KEYBOARD_PEDAL_KEY = 'ShiftLeft'

export class KeyboardInput extends InputEmitter {
  /** MIDI pitch of the first key on the lower row. */
  base = 48
  velocity = 90

  private readonly down = new Map<string, number>()
  private target: EventTarget | null = null

  constructor(private readonly toClock: ClockMapper) {
    super()
  }

  static pitchOffset(code: string): number | null {
    const lower = LOWER.indexOf(code)
    if (lower >= 0) return lower

    const upper = UPPER.indexOf(code)
    return upper >= 0 ? upper + 12 : null
  }

  attach(target: EventTarget = window): void {
    this.detach()
    this.target = target
    target.addEventListener('keydown', this.onKeyDown as EventListener)
    target.addEventListener('keyup', this.onKeyUp as EventListener)
    target.addEventListener('blur', this.releaseAll)
  }

  detach(): void {
    this.releaseAll()
    this.target?.removeEventListener('keydown', this.onKeyDown as EventListener)
    this.target?.removeEventListener('keyup', this.onKeyUp as EventListener)
    this.target?.removeEventListener('blur', this.releaseAll)
    this.target = null
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return

    const t = this.toClock(e.timeStamp)
    if (e.code === KEYBOARD_PEDAL_KEY) return this.emitPedal(64, 127, t)
    if (e.code === 'PageDown') return void (this.base = Math.max(24, this.base - 12))
    if (e.code === 'PageUp') return void (this.base = Math.min(84, this.base + 12))

    const offset = KeyboardInput.pitchOffset(e.code)
    if (offset === null || this.down.has(e.code)) return

    const pitch = this.base + offset
    this.down.set(e.code, pitch)
    this.emitNoteOn(pitch, this.velocity, t)
  }

  private onKeyUp = (e: KeyboardEvent) => {
    const t = this.toClock(e.timeStamp)
    if (e.code === KEYBOARD_PEDAL_KEY) return this.emitPedal(64, 0, t)

    const pitch = this.down.get(e.code)
    if (pitch === undefined) return
    this.down.delete(e.code)
    this.emitNoteOff(pitch, t)
  }

  private releaseAll = () => {
    for (const pitch of this.down.values()) this.emitNoteOff(pitch, 0)
    this.down.clear()
    this.emitPedal(64, 0, 0)
  }
}

/** True for fields that take typed text. Toggles and sliders don't swallow note keys or Space. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.matches(
      'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]), textarea, select',
    )
  )
}
