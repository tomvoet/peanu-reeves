import 'fake-indexeddb/auto'
import { Dexie } from 'dexie'
import { describe, expect, it } from 'vite-plus/test'
import { createRepositories, type Backup } from '../../db/repositories'
import { PracticeDb, type Attempt, type Piece, type Take } from '../../db/schema'

const piece = (hash: string, extra: Partial<Piece> = {}): Piece => ({
  hash,
  title: 'Song',
  durationSec: 10,
  trackCount: 2,
  addedAt: 1,
  ...extra,
})

const legacy = (hash: string, source: string) => ({ ...piece(hash), source, path: `${hash}.mid` })

const attempt = (hash: string): Omit<Attempt, 'id'> => ({
  hash,
  startedAt: 5,
  tempoFactor: 1,
  mode: 'normal',
  hands: { L: 'play', R: 'play' },
  accuracy: 0.9,
  meanDevMs: 0,
  notes: { hit: 9, wrong: 1, miss: 0 },
  perMeasure: [],
})

describe('pieces.rehash', () => {
  it('moves history, sections and overrides to the new hash', async () => {
    const repos = createRepositories(new PracticeDb(`test-${Math.random()}`))
    await repos.pieces.put(piece('old', { lastPlayedAt: 42 }))
    await repos.pieces.put(piece('new', { addedAt: 99 }))
    await repos.attempts.add(attempt('old'))
    await repos.sections.add({ hash: 'old', startMeasure: 0, endMeasure: 3, label: 'A' })
    await repos.overrides.put({ hash: 'old', handSplit: { mode: 'pitch', splitPitch: 55 } })

    await repos.pieces.rehash('old', 'new')

    expect(await repos.pieces.get('old')).toBeUndefined()
    const moved = await repos.pieces.get('new')
    expect(moved).toMatchObject({ addedAt: 1, lastPlayedAt: 42 })
    expect(moved?.revisedAt).toBeTypeOf('number')
    expect(await repos.attempts.forPiece('new')).toHaveLength(1)
    expect(await repos.sections.forPiece('new')).toHaveLength(1)
    expect((await repos.overrides.get('new'))?.handSplit.splitPitch).toBe(55)
    expect(await repos.overrides.get('old')).toBeUndefined()
  })
})

describe('locations', () => {
  it('lists only pieces on this device and keeps unlinked ones', async () => {
    const repos = createRepositories(new PracticeDb(`test-${Math.random()}`))
    await repos.pieces.put(piece('a'))
    await repos.pieces.put(piece('b'))
    await repos.locations.put({ hash: 'a', source: 'folder', path: 'a.mid' })
    await repos.locations.put({ hash: 'b', source: 'import', path: 'b.mid' })

    expect((await repos.pieces.library()).map((p) => [p.hash, p.source])).toEqual([
      ['a', 'folder'],
      ['b', 'import'],
    ])

    await repos.locations.clearFolder()
    expect((await repos.pieces.library()).map((p) => p.hash)).toEqual(['b'])
    expect(await repos.pieces.get('a')).toBeDefined()

    await repos.pieces.remove('b')
    expect(await repos.locations.get('b')).toBeUndefined()
  })

  it('moves locations out of pieces when upgrading from version 2', async () => {
    const name = `test-${Math.random()}`
    const old = new Dexie(name)
    old.version(2).stores({
      pieces: 'hash, title, path, source, lastPlayedAt',
      overrides: 'hash',
      sections: '++id, hash',
      attempts: '++id, hash, sectionId, startedAt',
      settings: 'key',
      files: 'hash',
      takes: '++id, hash, startedAt, starred, [hash+starred]',
      recordings: '++id, createdAt',
    })
    await old
      .table('pieces')
      .bulkPut([
        { ...legacy('a', 'folder'), fileSize: 3, fileModified: 4 },
        legacy('b', 'import'),
        legacy('demo', 'demo'),
      ])
    await old.table('sections').add({ hash: 'a', startMeasure: 0, endMeasure: 1, createdAt: 7 })
    await old.table('attempts').add({ ...attempt('a'), sectionId: 1 })
    await old.table('takes').add({ hash: 'a', startedAt: 5, attemptId: 1, starred: 0, events: [] })
    await old.table('recordings').add({ title: 'R', createdAt: 9, events: [] })
    old.close()

    const repos = createRepositories(new PracticeDb(name))
    expect((await repos.pieces.all()).map((p) => p.hash)).toEqual(['a', 'b'])
    expect(await repos.pieces.get('a')).not.toHaveProperty('path')
    expect(await repos.locations.get('a')).toEqual({
      hash: 'a',
      source: 'folder',
      path: 'a.mid',
      fileSize: 3,
      fileModified: 4,
    })
    expect((await repos.locations.get('b'))?.source).toBe('import')

    const [a] = await repos.attempts.forPiece('a')
    const [section] = await repos.sections.forPiece('a')
    const take = await repos.takes.latest('a')
    expect(a?.id).toBe('a-a-5')
    expect(a?.sectionId).toBe(section?.id)
    expect(take?.attemptId).toBe(a?.id)
    expect((await repos.recordings.all())[0]?.id).toBe('r-9')
  })
})

describe('backup', () => {
  it('round-trips data and keeps imported file bytes', async () => {
    const source = createRepositories(new PracticeDb(`test-${Math.random()}`))
    await source.pieces.put(piece('p1'))
    await source.locations.put({ hash: 'p1', source: 'import', path: 'p1.mid' })
    await source.files.put('p1', new Uint8Array([0, 1, 2, 255]).buffer)
    await source.attempts.add(attempt('p1'))
    await source.settings.save({ toleranceMs: 120 })
    const backup: Backup = JSON.parse(
      JSON.stringify(await source.backup.export({ 'practice:p1': '{}' })),
    )

    const target = createRepositories(new PracticeDb(`test-${Math.random()}`))
    await target.attempts.add(attempt('stale'))
    await target.backup.restore(backup)

    expect(await target.attempts.forPiece('stale')).toHaveLength(0)
    expect(await target.attempts.forPiece('p1')).toHaveLength(1)
    expect([...new Uint8Array((await target.files.get('p1'))!)]).toEqual([0, 1, 2, 255])
    expect((await target.settings.load()).toleranceMs).toBe(120)
    expect(backup.local).toEqual({ 'practice:p1': '{}' })
    expect(await target.backup.attemptsCsv()).toContain('Song,,,100,normal')
    expect((await target.pieces.library()).map((p) => p.source)).toEqual(['import'])
  })

  it('restores backups that keep locations on the pieces', async () => {
    const source = createRepositories(new PracticeDb(`test-${Math.random()}`))
    const backup = await source.backup.export()
    delete backup.locations
    backup.pieces = [legacy('p1', 'import')]

    const target = createRepositories(new PracticeDb(`test-${Math.random()}`))
    await target.backup.restore(backup)

    expect(await target.pieces.get('p1')).not.toHaveProperty('source')
    expect((await target.locations.get('p1'))?.path).toBe('p1.mid')
  })

  it('gives numeric ids from version 1 backups stable string ids', async () => {
    const source = createRepositories(new PracticeDb(`test-${Math.random()}`))
    const backup = await source.backup.export()
    backup.version = 1
    backup.attempts = [{ ...attempt('p1'), id: 3 as never }]
    backup.takes = [
      { hash: 'p1', startedAt: 5, attemptId: 3, starred: 1, events: [] } as never as Take,
    ]

    const target = createRepositories(new PracticeDb(`test-${Math.random()}`))
    await target.backup.restore(backup)

    expect((await target.takes.latest('p1'))?.attemptId).toBe('a-p1-5')
    expect((await target.attempts.forPiece('p1'))[0]?.id).toBe('a-p1-5')
  })
})

describe('takes', () => {
  it('keeps the newest unstarred takes per piece and every starred one', async () => {
    const repos = createRepositories(new PracticeDb(`test-${Math.random()}`))
    const take = (startedAt: number, starred: 0 | 1 = 0) => ({
      hash: 'p1',
      startedAt,
      fromSec: 0,
      toSec: 4,
      tempo: 1,
      accuracy: 0.9,
      starred,
      events: [],
    })
    await repos.takes.add(take(1, 1))
    for (let i = 2; i <= 6; i++) await repos.takes.add(take(i), 3)
    await repos.takes.add({ ...take(7), hash: 'other' }, 3)

    const kept = await repos.takes.forPiece('p1')
    expect(kept.map((t) => t.startedAt)).toEqual([6, 5, 4, 1])
    expect((await repos.takes.starredCounts()).get('p1')).toBe(1)
    expect(await repos.takes.forPiece('other')).toHaveLength(1)
  })
})
