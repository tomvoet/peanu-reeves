import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vite-plus/test'
import { sha256Hex } from '../../app/utils/format'
import { createRepositories, type Repositories } from '../../db/repositories'
import { PracticeDb, type Attempt, type Piece } from '../../db/schema'
import { memoryFolder, syncOnce, type SyncFolder } from '../../db/sync'

const piece = (hash: string): Piece => ({
  hash,
  title: 'Song',
  durationSec: 10,
  trackCount: 2,
  addedAt: 1,
})

const attempt = (hash: string, startedAt = 5): Omit<Attempt, 'id'> => ({
  hash,
  startedAt,
  tempoFactor: 1,
  mode: 'normal',
  hands: { L: 'play', R: 'play' },
  accuracy: 0.9,
  meanDevMs: 0,
  notes: { hit: 9, wrong: 1, miss: 0 },
  perMeasure: [],
})

function device(name: string): Repositories {
  const repos = createRepositories(new PracticeDb(`test-${Math.random()}`))
  repos.sync.start(name)
  return repos
}

const run = (repos: Repositories, folder: SyncFolder) =>
  syncOnce(repos, folder, {
    readMidi: async (hash) => (await repos.files.get(hash)) ?? null,
    sha256: sha256Hex,
    deviceName: 'test',
  })

/** Syncs every device twice, so each one has seen what the others pushed. */
async function settle(folder: SyncFolder, ...devices: Repositories[]) {
  for (let i = 0; i < 2; i++) for (const d of devices) await run(d, folder)
}

describe('sync', () => {
  it('carries history and MIDI files to another device', async () => {
    const folder = memoryFolder()
    const a = device('a')
    const b = device('b')

    const bytes = new Uint8Array([77, 84, 104, 100]).buffer
    const hash = await sha256Hex(bytes)
    await a.pieces.put(piece(hash))
    await a.locations.put({ hash, source: 'import', path: 'song.mid' })
    await a.files.put(hash, bytes)
    await a.attempts.add(attempt(hash))
    await a.sections.add({ hash, startMeasure: 0, endMeasure: 3, label: 'Intro' })

    await settle(folder, a, b)

    expect((await b.pieces.library()).map((p) => [p.hash, p.source])).toEqual([[hash, 'sync']])
    expect([...new Uint8Array((await b.files.get(hash))!)]).toEqual([77, 84, 104, 100])
    expect(await b.attempts.forPiece(hash)).toHaveLength(1)
    expect((await b.sections.forPiece(hash))[0]?.label).toBe('Intro')
    expect(await a.sync.pending()).toBe(0)
  })

  it('passes deletes along and keeps the newest write of a row', async () => {
    const folder = memoryFolder()
    const a = device('a')
    const b = device('b')
    const take = await a.takes.add({
      hash: 'p',
      startedAt: 1,
      fromSec: 0,
      toSec: 4,
      tempo: 1,
      accuracy: 1,
      starred: 0,
      events: [],
    })
    const section = await a.sections.add({ hash: 'p', startMeasure: 0, endMeasure: 1, label: 'S' })
    await settle(folder, a, b)

    await a.takes.setStarred(take, true)
    await new Promise((r) => setTimeout(r, 5))
    await b.takes.setStarred(take, false)
    await b.sections.remove(section)
    await settle(folder, a, b)

    expect((await a.takes.get(take))?.starred).toBe(0)
    expect((await b.takes.get(take))?.starred).toBe(0)
    expect(await a.sections.forPiece('p')).toHaveLength(0)
  })

  it('moves history recorded under an edited file to its new version', async () => {
    const folder = memoryFolder()
    const a = device('a')
    const b = device('b')
    await a.pieces.put(piece('old'))
    await settle(folder, a, b)

    // B practises the old version while A picks up the edit.
    await b.attempts.add(attempt('old', 1))
    await a.pieces.put(piece('new'))
    await a.pieces.rehash('old', 'new')
    await settle(folder, a, b)

    for (const d of [a, b]) {
      expect(await d.attempts.forPiece('new')).toHaveLength(1)
      expect(await d.pieces.get('old')).toBeUndefined()
    }
  })

  it('syncs shared settings only', async () => {
    const folder = memoryFolder()
    const a = device('a')
    const b = device('b')
    let arrived: Record<string, unknown> = {}
    b.sync.hooks.settings = (values) => (arrived = values)

    await a.settings.save({ theme: 'dark', volume: 30 })
    await settle(folder, a, b)

    expect(arrived).toEqual({ theme: 'dark' })
    const settings = await b.settings.load()
    expect(settings.theme).toBe('dark')
    expect(settings.volume).toBe(100)
  })

  it('waits for change files that are not fully synced yet', async () => {
    const folder = memoryFolder()
    const a = device('a')
    const b = device('b')
    await a.attempts.add(attempt('p'))
    await run(a, folder)

    const [path] = [...folder.data.keys()].filter((k) => k.endsWith('.jsonl'))
    const full = await folder.data.get(path!)!.text()
    folder.data.set(path!, new Blob([full.slice(0, 20)]))
    await run(b, folder)
    expect(await b.attempts.forPiece('p')).toHaveLength(0)

    folder.data.set(path!, new Blob([full]))
    await run(b, folder)
    expect(await b.attempts.forPiece('p')).toHaveLength(1)
  })

  it('picks a new device id when a copied profile writes under the same one', async () => {
    const folder = memoryFolder()
    const a = device('same')
    const copy = device('same')
    await a.attempts.add(attempt('p', 1))
    await copy.attempts.add(attempt('p', 2))
    await run(a, folder)
    await run(copy, folder)

    expect(copy.sync.device).not.toBe('same')
    expect(await copy.attempts.forPiece('p')).toHaveLength(2)
  })
})
