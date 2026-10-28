import { Dexie, type EntityTable } from 'dexie'
import type { NoteCounts, MeasureStats } from '../engine/stats/aggregate'
import type { ThumbNote } from '../engine/song/thumbnail'
import type { HandModes, HandSplit } from '../engine/types'
import type { TakeEvent } from '../engine/recording/take'

/** `sync` files came from another device through the sync folder. */
export type PieceSource = 'folder' | 'import' | 'sync'

export interface Piece {
  hash: string
  title: string
  durationSec: number
  trackCount: number
  addedAt: number
  lastPlayedAt?: number
  /** Set when the file changed on disk and its history was carried over from the old version. */
  revisedAt?: number
  /** Downsampled notes for the library thumbnail. */
  thumb?: PieceThumb
}

/** Where a piece's file is on this device. A piece without one keeps its history but is not listed. */
export interface PieceLocation {
  hash: string
  source: PieceSource
  path: string
  /** Folder files: size and modification time at the last scan, to skip unchanged files. */
  fileSize?: number
  fileModified?: number
}

export type LibraryPiece = Piece & PieceLocation

/** Pieces as stored before locations had their own table, also found in older backups. */
export type LegacyPiece = Piece & {
  source?: string
  path?: string
  fileSize?: number
  fileModified?: number
}

export function splitLegacyPiece(row: LegacyPiece): { piece: Piece; location?: PieceLocation } {
  const { source, path, fileSize, fileModified, ...piece } = row
  if ((source !== 'folder' && source !== 'import') || path === undefined) return { piece }
  return { piece, location: { hash: row.hash, source, path, fileSize, fileModified } }
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
  id: string
  hash: string
  startMeasure: number
  endMeasure: number
  label: string
  createdAt: number
}

export interface Attempt {
  id: string
  hash: string
  sectionId?: string
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
  id: string
  hash: string
  /** The attempt (scores) recorded alongside this take. */
  attemptId?: string
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
  id: string
  title: string
  createdAt: number
  durationSec: number
  bpm: number
  beatsPerBar: number
  /** Seconds from the start of the recording. */
  events: TakeEvent[]
  thumb?: PieceThumb
}

/** An edited file: history recorded under `from` belongs to the piece `to`. */
export interface Alias {
  from: string
  to: string
}

/** Clock of the last write to a synced row, deleted rows included. Key is `table/key`. */
export interface Version {
  key: string
  hlc: string
}

export type SyncedTable =
  | 'pieces'
  | 'aliases'
  | 'overrides'
  | 'sections'
  | 'attempts'
  | 'takes'
  | 'recordings'
  | 'settings'

/** One row written or deleted. `value` is the whole row, null for a delete. */
export interface Change {
  id: string
  hlc: string
  table: SyncedTable
  key: string
  value: unknown
}

export interface OutboxEntry {
  seq?: number
  change: Change
}

export interface SyncStateRow {
  key: string
  value: unknown
}

/** A change file from the sync folder that has been applied here. */
export interface AppliedFile {
  name: string
}

type LegacyRow = Record<string, unknown> & { id: number }

/**
 * Ids for rows from before ids were strings. They are derived from the row, so two devices
 * holding the same history (e.g. restored from one backup) end up with the same ids.
 */
export function legacyIds(rows: {
  sections: LegacyRow[]
  attempts: LegacyRow[]
  takes: LegacyRow[]
  recordings: LegacyRow[]
}) {
  const sectionIds = new Map(
    rows.sections.map((s) => [
      s.id,
      `s-${s.hash}-${s.createdAt}-${s.startMeasure}-${s.endMeasure}`,
    ]),
  )
  const attemptIds = new Map(rows.attempts.map((a) => [a.id, `a-${a.hash}-${a.startedAt}`]))
  const remap = (ids: Map<number, string>, id: unknown) =>
    typeof id === 'number' ? ids.get(id) : undefined

  return {
    sections: rows.sections.map((s) => ({ ...s, id: sectionIds.get(s.id)! })),
    attempts: rows.attempts.map((a) => ({
      ...a,
      id: attemptIds.get(a.id)!,
      sectionId: remap(sectionIds, a.sectionId),
    })),
    takes: rows.takes.map((t) => ({
      ...t,
      id: `t-${t.hash}-${t.startedAt}`,
      attemptId: remap(attemptIds, t.attemptId),
    })),
    recordings: rows.recordings.map((r) => ({ ...r, id: `r-${r.createdAt}` })),
  }
}

const ROW_TABLES = ['sections', 'attempts', 'takes', 'recordings'] as const

export class PracticeDb extends Dexie {
  pieces!: EntityTable<Piece, 'hash'>
  locations!: EntityTable<PieceLocation, 'hash'>
  overrides!: EntityTable<Override, 'hash'>
  sections!: EntityTable<Section, 'id'>
  attempts!: EntityTable<Attempt, 'id'>
  settings!: EntityTable<SettingRow, 'key'>
  files!: EntityTable<StoredFile, 'hash'>
  takes!: EntityTable<Take, 'id'>
  recordings!: EntityTable<Recording, 'id'>
  aliases!: EntityTable<Alias, 'from'>
  versions!: EntityTable<Version, 'key'>
  outbox!: EntityTable<OutboxEntry, 'seq'>
  syncState!: EntityTable<SyncStateRow, 'key'>
  appliedFiles!: EntityTable<AppliedFile, 'name'>

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
    this.version(3)
      .stores({
        pieces: 'hash, title, lastPlayedAt',
        locations: 'hash, source, path',
      })
      .upgrade(async (tx) => {
        // Demo songs bundled by earlier versions are dropped along the way.
        const split = ((await tx.table('pieces').toArray()) as LegacyPiece[])
          .filter((row) => row.source !== 'demo')
          .map(splitLegacyPiece)
        await tx.table('pieces').clear()
        await tx.table('pieces').bulkPut(split.map((s) => s.piece))
        await tx.table('locations').bulkPut(split.flatMap((s) => (s.location ? [s.location] : [])))
      })
    // Primary keys cannot change in place, so rows move out and back in with string ids.
    this.version(4)
      .stores({
        sectionsV3: 'id',
        attemptsV3: 'id',
        takesV3: 'id',
        recordingsV3: 'id',
        sections: null,
        attempts: null,
        takes: null,
        recordings: null,
      })
      .upgrade(async (tx) => {
        const read = async (name: string) => (await tx.table(name).toArray()) as LegacyRow[]
        const rows = legacyIds({
          sections: await read('sections'),
          attempts: await read('attempts'),
          takes: await read('takes'),
          recordings: await read('recordings'),
        })
        for (const name of ROW_TABLES) await tx.table(`${name}V3`).bulkPut(rows[name])
      })
    this.version(5)
      .stores({
        sections: 'id, hash',
        attempts: 'id, hash, sectionId, startedAt',
        takes: 'id, hash, startedAt, starred, [hash+starred]',
        recordings: 'id, createdAt',
        sectionsV3: null,
        attemptsV3: null,
        takesV3: null,
        recordingsV3: null,
        aliases: 'from, to',
        versions: 'key',
        outbox: '++seq',
        syncState: 'key',
        appliedFiles: 'name',
      })
      .upgrade(async (tx) => {
        for (const name of ROW_TABLES)
          await tx.table(name).bulkPut(await tx.table(`${name}V3`).toArray())
      })
  }
}
