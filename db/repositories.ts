import { defu } from 'defu'
import type { RemoteBindings } from '../engine/midi-input/remote'
import type { NoteLabels } from '../engine/render/renderer'
import {
  PracticeDb,
  type Attempt,
  type Override,
  type Piece,
  type PieceThumb,
  type Recording,
  type Section,
  type SettingRow,
  type Take,
} from './schema'

export interface AppSettings {
  inputOffsetMs: number
  toleranceMs: number
  midiDeviceId: string
  keyboardInput: boolean
  volume: number
  maxVoices: number
  lookahead: number
  noteLabels: NoteLabels
  /** Show only the octaves a piece uses. */
  fitKeyboard: boolean
  remote: RemoteBindings
  theme: 'system' | 'dark' | 'light'
  /** Hide controls and live stats while playing. */
  focusWhilePlaying: boolean
  /** Window counted as "on time" in timing feedback (ms either way). */
  timingWindowMs: 35 | 60
  lastBackupAt: number | null
  /** Sheet music above the falling notes. */
  showStaff: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  inputOffsetMs: 0,
  toleranceMs: 150,
  midiDeviceId: 'all',
  keyboardInput: true,
  volume: 100,
  maxVoices: 64,
  lookahead: 2.5,
  noteLabels: 'c',
  fitKeyboard: true,
  remote: {},
  theme: 'system',
  focusWhilePlaying: true,
  timingWindowMs: 35,
  lastBackupAt: null,
  showStaff: false,
}

const FOLDER_KEY = 'folderHandle'
/** Unstarred takes kept per piece. */
export const TAKES_KEPT = 10
const CSV_SPECIAL = /[",\n]/

export interface PieceSummary {
  count: number
  best: number | null
  last: Attempt | null
  lastAt: number
  /** Bars whose most recent result was below 85%. */
  weakBars: number[]
}

export interface Backup {
  app: 'peanu-reeves'
  version: 1
  exportedAt: number
  pieces: Piece[]
  overrides: Override[]
  sections: Section[]
  attempts: Attempt[]
  settings: SettingRow[]
  /** Imported MIDI files, base64 encoded. */
  files: { hash: string; data: string }[]
  /** Per-piece practice options kept in localStorage. */
  local: Record<string, string>
  /** Added later, missing in older backups. */
  takes?: Take[]
  recordings?: Recording[]
}

interface BarResult {
  acc: number
  at: number
}

const toBase64 = (data: ArrayBuffer): string => {
  const bytes = new Uint8Array(data)
  let bin = ''
  // Chunked so the spread stays under the engine's argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))

  return btoa(bin)
}

const fromBase64 = (text: string): ArrayBuffer =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0)).buffer

export function createRepositories(db = new PracticeDb()) {
  return {
    db,

    pieces: {
      all: () => db.pieces.orderBy('title').toArray(),
      get: (hash: string) => db.pieces.get(hash),
      put: (piece: Piece) => db.pieces.put(piece),
      /** Deletes demo songs bundled by earlier versions and returns how many were removed. */
      removeLegacyDemos: (): Promise<number> => db.pieces.where('source').equals('demo').delete(),
      touch: (hash: string) => db.pieces.update(hash, { lastPlayedAt: Date.now() }),
      setThumb: (hash: string, thumb: PieceThumb) => db.pieces.update(hash, { thumb }),
      /** Moves history, sections and overrides of an edited file over to its new content hash. */
      async rehash(oldHash: string, newHash: string): Promise<void> {
        if (oldHash === newHash) return
        await db.transaction(
          'rw',
          [db.pieces, db.overrides, db.sections, db.attempts, db.files, db.takes],
          async () => {
            const old = await db.pieces.get(oldHash)
            const override = await db.overrides.get(oldHash)

            if (old) {
              await db.pieces.update(newHash, {
                addedAt: old.addedAt,
                lastPlayedAt: old.lastPlayedAt,
                revisedAt: Date.now(),
              })
            }
            if (override && !(await db.overrides.get(newHash))) {
              await db.overrides.put({ ...override, hash: newHash })
            }

            await db.overrides.delete(oldHash)
            await db.sections.where({ hash: oldHash }).modify({ hash: newHash })
            await db.attempts.where({ hash: oldHash }).modify({ hash: newHash })
            await db.takes.where({ hash: oldHash }).modify({ hash: newHash })
            await db.pieces.delete(oldHash)
            await db.files.delete(oldHash)
          },
        )
      },
      async remove(hash: string): Promise<void> {
        await db.transaction('rw', [db.pieces, db.files], async () => {
          await db.pieces.delete(hash)
          await db.files.delete(hash)
        })
      },
    },

    files: {
      get: async (hash: string) => (await db.files.get(hash))?.data,
      put: (hash: string, data: ArrayBuffer) => db.files.put({ hash, data }),
    },

    overrides: {
      get: (hash: string) => db.overrides.get(hash),
      put: (override: Override) => db.overrides.put(override),
      remove: (hash: string) => db.overrides.delete(hash),
    },

    sections: {
      forPiece: (hash: string) => db.sections.where({ hash }).sortBy('startMeasure'),
      add: (section: Omit<Section, 'id' | 'createdAt'>) =>
        db.sections.add({ ...section, createdAt: Date.now() }),
      remove: (id: number) => db.sections.delete(id),
    },

    takes: {
      /** Stores a take and drops unstarred ones beyond the newest `keep` for that piece. */
      async add(take: Omit<Take, 'id'>, keep = TAKES_KEPT): Promise<number | undefined> {
        const id = await db.takes.add(take)
        const unstarred = await db.takes
          .where('[hash+starred]')
          .equals([take.hash, 0])
          .reverse()
          .sortBy('startedAt')
        await db.takes.bulkDelete(unstarred.slice(keep).flatMap((t) => (t.id ? [t.id] : [])))
        return id
      },
      forPiece: (hash: string): Promise<Take[]> =>
        db.takes.where({ hash }).reverse().sortBy('startedAt'),
      get: (id: number): Promise<Take | undefined> => db.takes.get(id),
      latest: async (hash: string): Promise<Take | undefined> =>
        (await db.takes.where({ hash }).reverse().sortBy('startedAt'))[0],
      starred: (): Promise<Take[]> =>
        db.takes.where('starred').equals(1).reverse().sortBy('startedAt'),
      setStarred: (id: number, starred: boolean): Promise<number> =>
        db.takes.update(id, { starred: starred ? 1 : 0 }),
      remove: (id: number): Promise<void> => db.takes.delete(id),
      /** Number of starred takes per piece. */
      async starredCounts(): Promise<Map<string, number>> {
        const counts = new Map<string, number>()
        await db.takes
          .where('starred')
          .equals(1)
          .each((t) => counts.set(t.hash, (counts.get(t.hash) ?? 0) + 1))
        return counts
      },
    },

    recordings: {
      add: (recording: Omit<Recording, 'id'>): Promise<number | undefined> =>
        db.recordings.add(recording),
      all: (): Promise<Recording[]> => db.recordings.orderBy('createdAt').reverse().toArray(),
      get: (id: number): Promise<Recording | undefined> => db.recordings.get(id),
      rename: (id: number, title: string): Promise<number> => db.recordings.update(id, { title }),
      remove: (id: number): Promise<void> => db.recordings.delete(id),
    },

    attempts: {
      add: (attempt: Omit<Attempt, 'id'>) => db.attempts.add(attempt),
      forPiece: (hash: string) => db.attempts.where({ hash }).reverse().sortBy('startedAt'),
      countsByPiece: async () => {
        const counts = new Map<string, number>()
        await db.attempts.each((a) => counts.set(a.hash, (counts.get(a.hash) ?? 0) + 1))
        return counts
      },
      summaryByPiece: async () => {
        const out = new Map<string, PieceSummary>()
        const bars = new Map<string, Map<number, BarResult>>()

        await db.attempts.each((a) => {
          const cur = out.get(a.hash) ?? {
            count: 0,
            best: null,
            last: null,
            lastAt: 0,
            weakBars: [],
          }
          cur.count++
          if (a.accuracy !== null && (cur.best === null || a.accuracy > cur.best))
            cur.best = a.accuracy
          if (a.startedAt > cur.lastAt) {
            cur.lastAt = a.startedAt
            cur.last = a
          }
          out.set(a.hash, cur)

          const latest = bars.get(a.hash) ?? new Map<number, BarResult>()
          for (const m of a.perMeasure) {
            const prev = latest.get(m.measure)
            if (m.accuracy !== null && (!prev || prev.at < a.startedAt))
              latest.set(m.measure, { acc: m.accuracy, at: a.startedAt })
          }
          bars.set(a.hash, latest)
        })

        for (const [hash, latest] of bars) {
          out.get(hash)!.weakBars = [...latest]
            .filter(([, v]) => v.acc < 0.85)
            .map(([m]) => m)
            .sort((x, y) => x - y)
        }

        return out
      },
    },

    backup: {
      async export(local: Record<string, string> = {}): Promise<Backup> {
        return {
          app: 'peanu-reeves',
          version: 1,
          exportedAt: Date.now(),
          pieces: await db.pieces.toArray(),
          overrides: await db.overrides.toArray(),
          sections: await db.sections.toArray(),
          attempts: await db.attempts.toArray(),
          settings: (await db.settings.toArray()).filter((r) => r.key !== FOLDER_KEY),
          files: (await db.files.toArray()).map((f) => ({ hash: f.hash, data: toBase64(f.data) })),
          local,
          takes: await db.takes.toArray(),
          recordings: await db.recordings.toArray(),
        }
      },
      /** Replaces everything except the linked folder with the backup's contents. */
      async restore(backup: Backup): Promise<void> {
        if (backup.app !== 'peanu-reeves' || backup.version !== 1)
          throw new Error('This is not a Peanu Reeves backup file.')

        await db.transaction(
          'rw',
          [
            db.pieces,
            db.overrides,
            db.sections,
            db.attempts,
            db.settings,
            db.files,
            db.takes,
            db.recordings,
          ],
          async () => {
            await Promise.all([
              db.pieces.clear(),
              db.overrides.clear(),
              db.sections.clear(),
              db.attempts.clear(),
              db.files.clear(),
              db.takes.clear(),
              db.recordings.clear(),
              db.settings.where('key').notEqual(FOLDER_KEY).delete(),
            ])

            await db.pieces.bulkPut(backup.pieces)
            await db.overrides.bulkPut(backup.overrides)
            await db.sections.bulkPut(backup.sections)
            await db.attempts.bulkPut(backup.attempts)
            await db.settings.bulkPut(backup.settings)
            await db.takes.bulkPut(backup.takes ?? [])
            await db.recordings.bulkPut(backup.recordings ?? [])
            await db.files.bulkPut(
              backup.files.map((f) => ({ hash: f.hash, data: fromBase64(f.data) })),
            )
          },
        )
      },
      async attemptsCsv(): Promise<string> {
        const titles = new Map((await db.pieces.toArray()).map((p) => [p.hash, p.title]))
        const rows = (await db.attempts.orderBy('startedAt').toArray()).map((a) => [
          new Date(a.startedAt).toISOString(),
          titles.get(a.hash) ?? a.hash,
          a.startMeasure === undefined ? '' : a.startMeasure + 1,
          a.endMeasure === undefined ? '' : a.endMeasure + 1,
          Math.round(a.tempoFactor * 100),
          a.mode,
          a.hands.L,
          a.hands.R,
          a.accuracy === null ? '' : (a.accuracy * 100).toFixed(1),
          a.notes.hit,
          a.notes.wrong,
          a.notes.miss,
          a.meanDevMs === null ? '' : Math.round(a.meanDevMs),
        ])

        const header = [
          'started',
          'piece',
          'from_bar',
          'to_bar',
          'tempo_pct',
          'mode',
          'left',
          'right',
          'accuracy_pct',
          'hit',
          'wrong',
          'missed',
          'timing_ms',
        ]
        const cell = (v: unknown) => {
          const text = String(v)
          return CSV_SPECIAL.test(text) ? `"${text.replaceAll('"', '""')}"` : text
        }

        return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n')
      },
    },

    settings: {
      async load(): Promise<AppSettings> {
        const rows = await db.settings.toArray()
        const stored = Object.fromEntries(
          rows.filter((r) => r.key !== FOLDER_KEY).map((r) => [r.key, r.value]),
        )
        return defu(stored, DEFAULT_SETTINGS) as AppSettings
      },
      async save(settings: Partial<AppSettings>): Promise<void> {
        await db.settings.bulkPut(Object.entries(settings).map(([key, value]) => ({ key, value })))
      },
      folder: async () =>
        (await db.settings.get(FOLDER_KEY))?.value as FileSystemDirectoryHandle | undefined,
      setFolder: (handle: FileSystemDirectoryHandle | null) =>
        handle
          ? db.settings.put({ key: FOLDER_KEY, value: handle })
          : db.settings.delete(FOLDER_KEY),
    },
  }
}

export type Repositories = ReturnType<typeof createRepositories>
