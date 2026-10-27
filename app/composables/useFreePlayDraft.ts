import type { ShallowRef } from 'vue'
import type { TakeEvent } from '#engine/recording/take'

/** A stopped Free play recording that has not been saved or discarded yet. */
export interface FreePlayDraft {
  /** Seconds from the start of the recording. */
  events: TakeEvent[]
  durationSec: number
  /** Kept part after trimming silence, seconds. */
  trimFrom: number
  trimTo: number
  createdAt: number
  bpm: number
  beatsPerBar: number
  /** Whether the metronome was on, so bar lines and the .mid grid mean something. */
  metronome: boolean
}

const draft = shallowRef<FreePlayDraft | null>(null)

/** Survives leaving the Free play page, until the next recording replaces it. */
export function useFreePlayDraft(): ShallowRef<FreePlayDraft | null> {
  return draft
}
