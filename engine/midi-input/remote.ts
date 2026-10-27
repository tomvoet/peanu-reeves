import type { Unsub } from '../types'

export const REMOTE_ACTIONS = [
  'toggle',
  'restart',
  'prevBar',
  'nextBar',
  'slower',
  'faster',
] as const
export type RemoteAction = (typeof REMOTE_ACTIONS)[number]

export type RemoteBinding = { kind: 'note'; number: number } | { kind: 'cc'; number: number }
export type RemoteBindings = Partial<Record<RemoteAction, RemoteBinding>>

export type InputEvent =
  | { type: 'noteOn'; pitch: number }
  | { type: 'noteOff'; pitch: number }
  | { type: 'control'; cc: number; value: number }

const same = (a: RemoteBinding, b: RemoteBinding) => a.kind === b.kind && a.number === b.number

/**
 * Turns chosen piano keys or pedals into app commands. Bound events are swallowed, so they
 * never sound or count as played notes.
 */
export class RemoteControl {
  bindings: RemoteBindings = {}
  private readonly handlers = new Map<RemoteAction, () => void>()
  private learning: ((binding: RemoteBinding) => void) | null = null
  /** Controllers currently held at or above the press threshold. */
  private readonly down = new Set<number>()

  /** Returns true when the event was used by the remote and must not reach anything else. */
  intercept = (e: InputEvent): boolean => {
    if (this.learning) {
      if (e.type === 'noteOn') this.finishLearning({ kind: 'note', number: e.pitch })
      else if (e.type === 'control' && e.value >= 64)
        this.finishLearning({ kind: 'cc', number: e.cc })
      return e.type !== 'noteOff'
    }

    if (e.type === 'control') {
      const action = this.actionFor({ kind: 'cc', number: e.cc })
      if (!action) return false

      const pressed = e.value >= 64
      if (pressed && !this.down.has(e.cc)) this.fire(action)
      if (pressed) this.down.add(e.cc)
      else this.down.delete(e.cc)
      return true
    }

    const action = this.actionFor({ kind: 'note', number: e.pitch })
    if (!action) return false
    if (e.type === 'noteOn') this.fire(action)
    return true
  }

  /** Resolves with the next key or pedal pressed. */
  learn(): Promise<RemoteBinding> {
    this.cancelLearning()
    return new Promise((resolve) => (this.learning = resolve))
  }

  cancelLearning(): void {
    this.learning = null
  }

  on(action: RemoteAction, handler: () => void): Unsub {
    this.handlers.set(action, handler)
    return () => {
      if (this.handlers.get(action) === handler) this.handlers.delete(action)
    }
  }

  actionFor(binding: RemoteBinding): RemoteAction | undefined {
    return (Object.keys(this.bindings) as RemoteAction[]).find((a) => {
      const b = this.bindings[a]
      return b && same(b, binding)
    })
  }

  private fire(action: RemoteAction): void {
    this.handlers.get(action)?.()
  }

  private finishLearning(binding: RemoteBinding): void {
    const done = this.learning
    this.learning = null
    done?.(binding)
  }
}
