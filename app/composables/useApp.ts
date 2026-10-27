import type { AppSettings, Repositories } from '#db/repositories'
import type { MidiDevice } from '#engine/midi-input/web-midi'
import type { Runtime } from '#engine/runtime'

export interface AudioStatus {
  loaded: number
  total: number
  ready: boolean
  error: string | null
  state: AudioContextState
}

export interface MidiStatus {
  readonly supported: boolean
  devices: MidiDevice[]
  error: string | null
  /** Chrome's MIDI permission for this site, 'unknown' where it cannot be queried. */
  permission: PermissionState | 'unknown'
  connected: boolean
  connecting: boolean
  /** Asks for access (shows Chrome's prompt) and starts listening. Call from a click. */
  connect: () => Promise<void>
}

export function useRuntime(): Runtime {
  return useNuxtApp().$runtime
}

export function useRepos(): Repositories {
  return useNuxtApp().$repos
}

export function useSettings(): AppSettings {
  return useNuxtApp().$settings
}

export function useAudioStatus(): AudioStatus {
  return useNuxtApp().$audio
}

export function useMidiStatus(): MidiStatus {
  return useNuxtApp().$midi
}
