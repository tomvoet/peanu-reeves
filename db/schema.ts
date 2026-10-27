import { Dexie, type EntityTable } from 'dexie'
import type { NoteCounts, MeasureStats } from '../engine/stats/aggregate'
import type { ThumbNote } from '../engine/song/thumbnail'
import type { HandModes, HandSplit } from '../engine/types'
import type { TakeEvent } from '../engine/recording/take'

export type PieceSource = 'folder' | 'import'

export interface Piece {
  hash: string
  title: string
  path: string
  source: PieceSource
  durationSec: number
  trackCount: number
  addedAt: number
  lastPlayedAt?: number
  /** Set when the file changed on disk and its history was carried over from the old version. */
  revisedAt?: number
  /** Downsampled notes for the library thumbnail. */
  thumb?: PieceThumb
  /** Folder files: size and modification time at the last scan, to skip unchanged files. */
  fileSize?: number
  fileModified?: number
}

export interface PieceThumb {
  durationSec: number
  /** Start time of every bar, in seconds. */
  barStarts: number[]
  notes: ThumbNote[]
}

export interface Override {
  hash: string
  handSplit: HandSplit
  /** Reserved for fingering, not used yet. */
  fingering?: Record<string, number>
}

export interface Section {
  id?: number
  hash: string
  startMeasure: number
  endMeasure: number
  label: string
  createdAt: number
}

export interface Attempt {
  id?: number
  hash: string
  sectionId?: number
  startedAt: number
  tempoFactor: number
  mode: 'normal' | 'wait'
  hands: HandModes
  startMeasure?: number
  endMeasure?: number
  accuracy: number | null
  meanDevMs: number | null
  notes: NoteCounts
  perMeasure: MeasureStats[]
}

export interface SettingRow {
  key: string
  value: unknown
}

/** Raw bytes for drag-and-drop imports that have no folder to come from. */
export interface StoredFile {
  hash: string
  data: ArrayBuffer
}

/** A finished pass as it was played, kept to listen back and compare against the score. */
export interface Take {
  id?: number
  hash: string
  /** The attempt (scores) recorded alongside this take. */
  attemptId?: number
  startedAt: number
  startMeasure?: number
  endMeasure?: number
  /** Song seconds the pass covered. */
  fromSec: number
  toSec: number
  tempo: number
  accuracy: number | null
  /** 1 when starred, a number so it can be indexed. Starred takes are never cleaned up. */
  starred: 0 | 1
  events: TakeEvent[]
}

/** Something played in Free play, outside any piece. */
export interface Recording {
  id?: number
  title: string
  createdAt: number
  durationSec: number
  bpm: number
  beatsPerBar: number
  /** Seconds from the start of the recording. */
  events: TakeEvent[]
  thumb?: PieceThumb
}

export class PracticeDb extends Dexie {
  pieces!: EntityTable<Piece, 'hash'>
  overrides!: EntityTable<Override, 'hash'>
  sections!: EntityTable<Section, 'id'>
  attempts!: EntityTable<Attempt, 'id'>
  settings!: EntityTable<SettingRow, 'key'>
  files!: EntityTable<StoredFile, 'hash'>
  takes!: EntityTable<Take, 'id'>
  recordings!: EntityTable<Recording, 'id'>

  constructor(name = 'peanu-reeves') {
    super(name)
    this.version(1).stores({
      pieces: 'hash, title, path, source, lastPlayedAt',
      overrides: 'hash',
      sections: '++id, hash',
      attempts: '++id, hash, sectionId, startedAt',
      settings: 'key',
      files: 'hash',
    })
    this.version(2).stores({
      takes: '++id, hash, startedAt, starred, [hash+starred]',
      recordings: '++id, createdAt',
    })
  }
}
