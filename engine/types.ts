export type Hand = 'L' | 'R'
export type HandMode = 'play' | 'auto' | 'ghost' | 'hidden'
export type HandModes = Record<Hand, HandMode>
export type Unsub = () => void

export interface SongNote {
  id: string
  pitch: number
  startTick: number
  endTick: number
  startSec: number
  endSec: number
  velocity: number
  hand: Hand
  measure: number
  track: number
}

export interface Measure {
  index: number
  startTick: number
  endTick: number
  startSec: number
  endSec: number
  numerator: number
  denominator: number
}

export interface TrackInfo {
  index: number
  name: string
  noteCount: number
  meanPitch: number
}

/** `smart` works the hands out from the notes themselves (see hand-separation.ts). */
export type HandSplitMode = 'auto' | 'tracks' | 'pitch' | 'smart'

export interface HandSplit {
  mode: HandSplitMode
  splitPitch?: number
  trackMap?: Record<number, Hand>
  /** Per-note corrections by note id. In smart mode the rest is re-solved around them. */
  fixes?: Record<string, Hand>
}

export interface Song {
  title: string
  ppq: number
  durationSec: number
  notes: SongNote[]
  measures: Measure[]
  tracks: TrackInfo[]
  /** The split actually applied (never 'auto'). */
  handSplit: HandSplit
  /** Key signature from the file as sharps (positive) or flats (negative), if it has one. */
  keyFifths?: number
}
