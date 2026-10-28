import { defu } from 'defu'
import type { Table } from 'dexie'
import { DEFAULT_TONE, type ToneId } from '../engine/audio/tones'
import type { RemoteBindings } from '../engine/midi-input/remote'
import type { NoteLabels } from '../engine/render/renderer'
import { Clock } from './clock'
import {
  PracticeDb,
  legacyIds,
  splitLegacyPiece,
  type Alias,
  type Attempt,
  type Change,
  type LegacyPiece,
  type LibraryPiece,
  type OutboxEntry,
  type Override,
  type Piece,
  type PieceLocation,
  type PieceThumb,
  type Recording,
  type Section,
  type SettingRow,
  type SyncedTable,
  type Take,
} from './schema'

export interface AppSettings {
  inputOffsetMs: number
  toleranceMs: number
  midiDeviceId: string
  keyboardInput: boolean
  volume: number
  maxVoices: number
  tone: ToneId
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
  tone: DEFAULT_TONE,
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

/** Settings shared between devices. The rest belongs to one device: its MIDI setup, audio, calibration. */
export const SYNCED_SETTINGS = [
  'tone',
  'theme',
  'focusWhilePlaying',
  'timingWindowMs',
  'showStaff',
] as const satisfies (keyof AppSettings)[]

const isSyncedSetting = (key: string): boolean =>
  (SYNCED_SETTINGS as readonly string[]).includes(key)

const FOLDER_KEY = 'folderHandle'
/** Unstarred takes kept per piece. */
export const TAKES_KEPT = 10
const CSV_SPECIAL = /[",\n]/
/** Longest chain of edits followed from an old file version to the current one. */
const MAX_ALIAS_HOPS = 50

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
  /** 1 had numeric row ids. */
  version: 1 | 2
  exportedAt: number
  /** Older backups have the location fields on each piece instead of `locations`. */
  pieces: LegacyPiece[]
  locations?: PieceLocation[]
  aliases?: Alias[]
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

const newId = (): string => crypto.randomUUID()

export function createRepositories(db = new PracticeDb()) {
  /** Set while sync is on. Writes to synced tables are then recorded in the outbox. */
  let clock: Clock | null = null
  const hooks: {
    /** A local change is waiting to be pushed. */
    tracked?: () => void
    /** Synced settings arrived from another device. */
    settings?: (values: Record<string, unknown>) => void
  } = {}

  const syncedTables = (): Record<SyncedTable, Table> => ({
    pieces: db.pieces,
    aliases: db.aliases,
    overrides: db.overrides,
    sections: db.sections,
    attempts: db.attempts,
    takes: db.takes,
    recordings: db.recordings,
    settings: db.settings,
  })

  /** Runs `fn` in a transaction that can also record changes. */
  const write = <T>(tables: Table[], fn: () => Promise<T>): Promise<T> =>
    db.transaction('rw', [...tables, db.versions, db.outbox], fn)

  /** Records a write to a synced row. `value` is the whole row, or null when it was deleted. */
  async function track(table: SyncedTable, key: string, value: unknown): Promise<void> {
    if (!clock) return
    const hlc = clock.tick()
    await db.versions.put({ key: `${table}/${key}`, hlc })
    await db.outbox.add({ change: { id: newId(), hlc, table, key, value: value ?? null } })
    queueMicrotask(() => hooks.tracked?.())
  }

  /** The current version of a file, following edits recorded as aliases. */
  async function resolve(hash: string): Promise<string> {
    let current = hash
    const seen = new Set([hash])
    for (let i = 0; i < MAX_ALIAS_HOPS; i++) {
      const alias = await db.aliases.get(current)
      if (!alias || seen.has(alias.to)) break
      seen.add(alias.to)
      current = alias.to
    }
    return current
  }

  /** Moves history, sections and overrides from one file version to another. Not tracked. */
  async function moveHash(oldHash: string, newHash: string): Promise<void> {
    if (oldHash === newHash) return
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
    await db.locations.delete(oldHash)
    await db.files.delete(oldHash)
  }

  const historyTables = [
    db.pieces,
    db.locations,
    db.aliases,
    db.overrides,
    db.sections,
    db.attempts,
    db.files,
    db.takes,
  ]

  /** Applies one change from another device, which is newer than anything seen for its row. */
  async function applyChange(c: Change, settings: Record<string, unknown>): Promise<void> {
    const deleted = c.value === null
    switch (c.table) {
      case 'pieces': {
        if (deleted) {
          await db.pieces.delete(c.key)
          await db.locations.delete(c.key)
          await db.files.delete(c.key)
          return
        }
        const piece = c.value as Piece
        const to = await resolve(c.key)
        if (to === c.key) return void (await db.pieces.put(piece))
        // A version of the file that was edited since: only the last play still counts.
        const current = await db.pieces.get(to)
        if (current && (piece.lastPlayedAt ?? 0) > (current.lastPlayedAt ?? 0))
          await db.pieces.update(to, { lastPlayedAt: piece.lastPlayedAt })
        return
      }
      case 'aliases': {
        if (deleted) return void (await db.aliases.delete(c.key))
        const alias = c.value as Alias
        await db.aliases.put(alias)
        await moveHash(alias.from, await resolve(alias.to))
        return
      }
      case 'overrides':
        if (deleted) return void (await db.overrides.delete(c.key))
        await db.overrides.put({ ...(c.value as Override), hash: await resolve(c.key) })
        return
      case 'sections':
      case 'attempts':
      case 'takes': {
        const table = syncedTables()[c.table]
        if (deleted) return void (await table.delete(c.key))
        const row = c.value as { hash: string }
        await table.put({ ...row, hash: await resolve(row.hash) })
        return
      }
      case 'recordings':
        if (deleted) return void (await db.recordings.delete(c.key))
        await db.recordings.put(c.value as Recording)
        return
      case 'settings': {
        if (deleted || !isSyncedSetting(c.key)) return
        const { value } = c.value as SettingRow
        await db.settings.put({ key: c.key, value })
        settings[c.key] = value
      }
    }
  }

  /** Records every synced row as written now, for the first push or after a restore. */
  async function seed(): Promise<void> {
    for (const [table, store] of Object.entries(syncedTables()) as [SyncedTable, Table][]) {
      const keyPath = store.schema.primKey.keyPath as string
      await write([store], async () => {
        for (const row of (await store.toArray()) as Record<string, unknown>[]) {
          const key = String(row[keyPath])
          if (table === 'settings' && !isSyncedSetting(key)) continue
          await track(table, key, row)
        }
      })
    }
  }

  async function resetSync(): Promise<void> {
    await db.transaction('rw', [db.versions, db.outbox, db.appliedFiles], async () => {
      await db.versions.clear()
      await db.outbox.clear()
      await db.appliedFiles.clear()
    })
  }

  return {
    db,

    pieces: {
      all: () => db.pieces.orderBy('title').toArray(),
      /** Pieces whose file is on this device. */
      async library(): Promise<LibraryPiece[]> {
        const [pieces, locations] = await Promise.all([
          db.pieces.orderBy('title').toArray(),
          db.locations.toArray(),
        ])
        const at = new Map(locations.map((l) => [l.hash, l]))
        return pieces.flatMap((p) => {
          const location = at.get(p.hash)
          return location ? [{ ...p, ...location }] : []
        })
      },
      /** Pieces known from other devices whose file is not here yet. */
      async missing(): Promise<Piece[]> {
        const here = new Set(await db.locations.toCollection().primaryKeys())
        return (await db.pieces.toArray()).filter((p) => !here.has(p.hash))
      },
      get: (hash: string) => db.pieces.get(hash),
      put: (piece: Piece) =>
        write([db.pieces], async () => {
          await db.pieces.put(piece)
          await track('pieces', piece.hash, piece)
        }),
      touch: (hash: string) =>
        write([db.pieces], async () => {
          await db.pieces.update(hash, { lastPlayedAt: Date.now() })
          await track('pieces', hash, await db.pieces.get(hash))
        }),
      setThumb: (hash: string, thumb: PieceThumb) =>
        write([db.pieces], async () => {
          if (!(await db.pieces.update(hash, { thumb }))) return
          await track('pieces', hash, await db.pieces.get(hash))
        }),
      /** Moves history, sections and overrides of an edited file over to its new content hash. */
      async rehash(oldHash: string, newHash: string): Promise<void> {
        if (oldHash === newHash) return
        await write(historyTables, async () => {
          const hadOverride = !!(await db.overrides.get(oldHash))
          await moveHash(oldHash, newHash)

          // An edit that was undone: the newer version now points back at this one.
          if (await db.aliases.get(newHash)) {
            await db.aliases.delete(newHash)
            await track('aliases', newHash, null)
          }
          const alias = { from: oldHash, to: newHash }
          await db.aliases.put(alias)
          await track('aliases', oldHash, alias)

          const piece = await db.pieces.get(newHash)
          if (piece) await track('pieces', newHash, piece)
          if (hadOverride) await track('overrides', newHash, await db.overrides.get(newHash))
        })
      },
      /** Removes the piece itself, not just from this device. Its history stays. */
      remove: (hash: string) =>
        write([db.pieces, db.locations, db.files], async () => {
          await db.pieces.delete(hash)
          await db.locations.delete(hash)
          await db.files.delete(hash)
          await track('pieces', hash, null)
        }),
    },

    locations: {
      get: (hash: string) => db.locations.get(hash),
      put: (location: PieceLocation) => db.locations.put(location),
      /** The piece stays, it is just no longer on this device. */
      remove: (hash: string) => db.locations.delete(hash),
      all: () => db.locations.toArray(),
      folder: () => db.locations.where('source').equals('folder').toArray(),
      clearFolder: () => db.locations.where('source').equals('folder').delete(),
    },

    files: {
      get: async (hash: string) => (await db.files.get(hash))?.data,
      put: (hash: string, data: ArrayBuffer) => db.files.put({ hash, data }),
    },

    overrides: {
      get: (hash: string) => db.overrides.get(hash),
      put: (override: Override) =>
        write([db.overrides], async () => {
          await db.overrides.put(override)
          await track('overrides', override.hash, override)
        }),
      remove: (hash: string) =>
        write([db.overrides], async () => {
          await db.overrides.delete(hash)
          await track('overrides', hash, null)
        }),
    },

    sections: {
      forPiece: (hash: string) => db.sections.where({ hash }).sortBy('startMeasure'),
      add: (section: Omit<Section, 'id' | 'createdAt'>) =>
        write([db.sections], async () => {
          const row = { ...section, id: newId(), createdAt: Date.now() }
          await db.sections.add(row)
          await track('sections', row.id, row)
          return row.id
        }),
      remove: (id: string) =>
        write([db.sections], async () => {
          await db.sections.delete(id)
          await track('sections', id, null)
        }),
    },

    takes: {
      /** Stores a take and drops unstarred ones beyond the newest `keep` for that piece. */
      add: (take: Omit<Take, 'id'>, keep = TAKES_KEPT): Promise<string> =>
        write([db.takes], async () => {
          const row = { ...take, id: newId() }
          await db.takes.add(row)
          await track('takes', row.id, row)
          const unstarred = await db.takes
            .where('[hash+starred]')
            .equals([take.hash, 0])
            .reverse()
            .sortBy('startedAt')
          for (const old of unstarred.slice(keep)) {
            await db.takes.delete(old.id)
            await track('takes', old.id, null)
          }
          return row.id
        }),
      forPiece: (hash: string): Promise<Take[]> =>
        db.takes.where({ hash }).reverse().sortBy('startedAt'),
      get: (id: string): Promise<Take | undefined> => db.takes.get(id),
      latest: async (hash: string): Promise<Take | undefined> =>
        (await db.takes.where({ hash }).reverse().sortBy('startedAt'))[0],
      starred: (): Promise<Take[]> =>
        db.takes.where('starred').equals(1).reverse().sortBy('startedAt'),
      setStarred: (id: string, starred: boolean) =>
        write([db.takes], async () => {
          if (!(await db.takes.update(id, { starred: starred ? 1 : 0 }))) return
          await track('takes', id, await db.takes.get(id))
        }),
      remove: (id: string) =>
        write([db.takes], async () => {
          await db.takes.delete(id)
          await track('takes', id, null)
        }),
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
      add: (recording: Omit<Recording, 'id'>): Promise<string> =>
        write([db.recordings], async () => {
          const row = { ...recording, id: newId() }
          await db.recordings.add(row)
          await track('recordings', row.id, row)
          return row.id
        }),
      all: (): Promise<Recording[]> => db.recordings.orderBy('createdAt').reverse().toArray(),
      get: (id: string): Promise<Recording | undefined> => db.recordings.get(id),
      rename: (id: string, title: string) =>
        write([db.recordings], async () => {
          if (!(await db.recordings.update(id, { title }))) return
          await track('recordings', id, await db.recordings.get(id))
        }),
      remove: (id: string) =>
        write([db.recordings], async () => {
          await db.recordings.delete(id)
          await track('recordings', id, null)
        }),
    },

    attempts: {
      add: (attempt: Omit<Attempt, 'id'>): Promise<string> =>
        write([db.attempts], async () => {
          const row = { ...attempt, id: newId() }
          await db.attempts.add(row)
          await track('attempts', row.id, row)
          return row.id
        }),
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
          version: 2,
          exportedAt: Date.now(),
          pieces: await db.pieces.toArray(),
          locations: await db.locations.toArray(),
          aliases: await db.aliases.toArray(),
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
      /**
       * Replaces everything except the linked folder with the backup's contents. With sync on,
       * the restored rows count as written now and everything from other devices is read again.
       */
      async restore(backup: Backup): Promise<void> {
        if (backup.app !== 'peanu-reeves' || (backup.version !== 1 && backup.version !== 2))
          throw new Error('This is not a Peanu Reeves backup file.')

        const rows =
          backup.version === 1
            ? legacyIds({
                sections: backup.sections as never,
                attempts: backup.attempts as never,
                takes: (backup.takes ?? []) as never,
                recordings: (backup.recordings ?? []) as never,
              })
            : {
                sections: backup.sections,
                attempts: backup.attempts,
                takes: backup.takes ?? [],
                recordings: backup.recordings ?? [],
              }

        await db.transaction(
          'rw',
          [
            db.pieces,
            db.locations,
            db.aliases,
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
              db.locations.clear(),
              db.aliases.clear(),
              db.overrides.clear(),
              db.sections.clear(),
              db.attempts.clear(),
              db.files.clear(),
              db.takes.clear(),
              db.recordings.clear(),
              db.settings.where('key').notEqual(FOLDER_KEY).delete(),
            ])

            const split = backup.pieces.map(splitLegacyPiece)
            await db.pieces.bulkPut(split.map((s) => s.piece))
            await db.locations.bulkPut(
              backup.locations ?? split.flatMap((s) => (s.location ? [s.location] : [])),
            )
            await db.aliases.bulkPut(backup.aliases ?? [])
            await db.overrides.bulkPut(backup.overrides)
            await db.sections.bulkPut(rows.sections as Section[])
            await db.attempts.bulkPut(rows.attempts as Attempt[])
            await db.settings.bulkPut(backup.settings)
            await db.takes.bulkPut(rows.takes as Take[])
            await db.recordings.bulkPut(rows.recordings as Recording[])
            await db.files.bulkPut(
              backup.files.map((f) => ({ hash: f.hash, data: fromBase64(f.data) })),
            )
          },
        )

        if (clock) {
          await resetSync()
          await seed()
        }
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
      save: (settings: Partial<AppSettings>) =>
        write([db.settings], async () => {
          for (const [key, value] of Object.entries(settings)) {
            await db.settings.put({ key, value })
            if (isSyncedSetting(key)) await track('settings', key, { key, value })
          }
        }),
      folder: async () =>
        (await db.settings.get(FOLDER_KEY))?.value as FileSystemDirectoryHandle | undefined,
      setFolder: (handle: FileSystemDirectoryHandle | null) =>
        handle
          ? db.settings.put({ key: FOLDER_KEY, value: handle })
          : db.settings.delete(FOLDER_KEY),
    },

    sync: {
      hooks,
      get enabled(): boolean {
        return clock !== null
      },
      get device(): string | null {
        return clock?.device ?? null
      },
      /** Starts recording changes under this device id. */
      start(device: string): void {
        if (clock) clock.device = device
        else clock = new Clock(device)
      },
      async stop(): Promise<void> {
        clock = null
        await resetSync()
      },
      seed,
      reset: resetSync,
      async getState<T>(key: string): Promise<T | undefined> {
        return (await db.syncState.get(key))?.value as T | undefined
      },
      setState: (key: string, value: unknown) =>
        value === undefined ? db.syncState.delete(key) : db.syncState.put({ key, value }),
      outbox: (): Promise<OutboxEntry[]> => db.outbox.orderBy('seq').toArray(),
      pending: (): Promise<number> => db.outbox.count(),
      /** Drops pushed changes. */
      clearOutbox: (upTo: number) => db.outbox.where('seq').belowOrEqual(upTo).delete(),
      async unapplied(names: string[]): Promise<string[]> {
        const done = await db.appliedFiles.bulkGet(names)
        return names.filter((_, i) => !done[i])
      },
      markApplied: (names: string[]) => db.appliedFiles.bulkPut(names.map((name) => ({ name }))),
      /** Applies changes from other devices. Each row keeps whichever write is newest. */
      async apply(changes: Change[]): Promise<number> {
        const sorted = changes.toSorted((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0))
        const settings: Record<string, unknown> = {}
        let applied = 0

        await write([...historyTables, db.recordings, db.settings], async () => {
          for (const c of sorted) {
            clock?.observe(c.hlc)
            const key = `${c.table}/${c.key}`
            const seen = await db.versions.get(key)
            if (seen && seen.hlc >= c.hlc) continue
            await db.versions.put({ key, hlc: c.hlc })
            await applyChange(c, settings)
            applied++
          }
        })

        if (Object.keys(settings).length) hooks.settings?.(settings)
        return applied
      },
    },
  }
}

export type Repositories = ReturnType<typeof createRepositories>
