import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vite-plus/test'
import { createRepositories, type Backup } from '../../db/repositories'
import { PracticeDb, type Attempt, type Piece } from '../../db/schema'

const piece = (hash: string, extra: Partial<Piece> = {}): Piece => ({
  hash,
  title: 'Song',
  path: 'a/song.mid',
  source: 'folder',
  durationSec: 10,
  trackCount: 2,
  addedAt: 1,
  ...extra,
})

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

describe('backup', () => {
  it('round-trips data and keeps imported file bytes', async () => {
    const source = createRepositories(new PracticeDb(`test-${Math.random()}`))
    await source.pieces.put(piece('p1', { source: 'import' }))
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
