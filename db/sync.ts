import type { Repositories } from './repositories'
import type { Change, SyncedTable } from './schema'

/** Layout version of the sync folder. A newer one is left alone. */
export const SYNC_FORMAT = 1
const MAX_MIDI_BYTES = 2 * 1024 * 1024
const MAX_CHANGE_FILE_BYTES = 64 * 1024 * 1024
const TABLES = new Set<SyncedTable>([
  'pieces',
  'aliases',
  'overrides',
  'sections',
  'attempts',
  'takes',
  'recordings',
  'settings',
])

/** The few file operations sync needs, so tests can run on memory instead of a real folder. */
export interface SyncFolder {
  /** Names of the files in a folder, empty when it does not exist. */
  files(path: string[]): Promise<string[]>
  folders(path: string[]): Promise<string[]>
  read(path: string[], name: string): Promise<Blob | null>
  write(path: string[], name: string, data: Blob | string): Promise<void>
}

export function handleFolder(root: FileSystemDirectoryHandle): SyncFolder {
  async function dir(path: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let current = root
    try {
      for (const part of path) current = await current.getDirectoryHandle(part, { create })
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotFoundError') return null
      throw e
    }
    return current
  }

  async function entries(path: string[], kind: FileSystemHandleKind): Promise<string[]> {
    const handle = await dir(path, false)
    const out: string[] = []
    if (handle)
      for await (const entry of handle.values()) if (entry.kind === kind) out.push(entry.name)
    return out
  }

  return {
    files: (path) => entries(path, 'file'),
    folders: (path) => entries(path, 'directory'),
    async read(path, name) {
      const handle = await dir(path, false)
      try {
        return (await handle?.getFileHandle(name))?.getFile() ?? null
      } catch (e) {
        if (e instanceof DOMException && e.name === 'NotFoundError') return null
        throw e
      }
    },
    async write(path, name, data) {
      const file = await (await dir(path, true))!.getFileHandle(name, { create: true })
      const out = await file.createWritable()
      await out.write(data)
      await out.close()
    },
  }
}

export function memoryFolder(): SyncFolder & { data: Map<string, Blob> } {
  const data = new Map<string, Blob>()
  const children = (path: string[]) => {
    const prefix = path.length ? `${path.join('/')}/` : ''
    return [...data.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length).split('/'))
  }
  return {
    data,
    files: async (path) => children(path).flatMap((p) => (p.length === 1 ? [p[0]!] : [])),
    folders: async (path) => [
      ...new Set(children(path).flatMap((p) => (p.length > 1 ? [p[0]!] : []))),
    ],
    read: async (path, name) => data.get([...path, name].join('/')) ?? null,
    write: async (path, name, blob) =>
      void data.set([...path, name].join('/'), typeof blob === 'string' ? new Blob([blob]) : blob),
  }
}

export interface SyncOptions {
  /** This device's piece file, or null when it cannot be read without asking for permission. */
  readMidi(hash: string): Promise<ArrayBuffer | null>
  sha256(data: ArrayBuffer): Promise<string>
  deviceName: string
}

export interface SyncReport {
  pushed: number
  applied: number
  uploaded: number
  downloaded: number
  /** Other devices writing to the folder. */
  devices: number
  /** Lines or files that could not be used. */
  problems: string[]
}

function isChange(c: unknown): c is Change {
  if (typeof c !== 'object' || c === null) return false
  const o = c as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.hlc === 'string' &&
    typeof o.key === 'string' &&
    TABLES.has(o.table as SyncedTable) &&
    'value' in o
  )
}

const randomName = (): string => crypto.randomUUID().slice(0, 8)

/** One round: push local changes, apply everyone else's, then exchange MIDI files. */
export async function syncOnce(
  repos: Repositories,
  folder: SyncFolder,
  opts: SyncOptions,
): Promise<SyncReport> {
  const device = repos.sync.device
  if (!device) throw new Error('Sync is not on.')
  const report: SyncReport = {
    pushed: 0,
    applied: 0,
    uploaded: 0,
    downloaded: 0,
    devices: 0,
    problems: [],
  }

  const format = await folder.read([], 'format.json')
  if (format) {
    const version = Number(
      (JSON.parse((await format.text()) || '{}') as { format?: unknown }).format,
    )
    if (version > SYNC_FORMAT)
      throw new Error('This sync folder was written by a newer version of the app. Update first.')
  } else {
    await folder.write([], 'format.json', `${JSON.stringify({ format: SYNC_FORMAT })}\n`)
  }

  const own = ['devices', device]
  if (!(await folder.read(own, 'device.json')))
    await folder.write(
      own,
      'device.json',
      `${JSON.stringify({ name: opts.deviceName, createdAt: Date.now() })}\n`,
    )

  // Push. Each push is a new file that is never touched again.
  const outbox = await repos.sync.outbox()
  if (outbox.length) {
    const seq = ((await repos.sync.getState<number>('seq')) ?? 0) + 1
    const name = `${String(seq).padStart(8, '0')}-${randomName()}.jsonl`
    const text = outbox.map((e) => `${JSON.stringify(e.change)}\n`).join('')
    await folder.write([...own, 'changes'], name, text)
    await repos.sync.markApplied([`${device}/${name}`])
    await repos.sync.setState('seq', seq)
    await repos.sync.clearOutbox(outbox.at(-1)!.seq!)
    report.pushed = outbox.length
  }

  // Pull.
  const changes: Change[] = []
  const done: string[] = []
  let cloned = false
  for (const dev of await folder.folders(['devices'])) {
    if (dev !== device) report.devices++
    const path = ['devices', dev, 'changes']
    const names = (await folder.files(path)).filter((n) => n.endsWith('.jsonl'))
    for (const key of await repos.sync.unapplied(names.map((n) => `${dev}/${n}`))) {
      const name = key.slice(dev.length + 1)
      const blob = await folder.read(path, name)
      if (!blob) continue
      if (blob.size > MAX_CHANGE_FILE_BYTES) {
        report.problems.push(`${key} is too large`)
        done.push(key)
        continue
      }
      const text = await blob.text()
      // The cloud client is still writing it. Files are complete once they end in a newline.
      if (!text.endsWith('\n')) continue

      let bad = 0
      for (const line of text.split('\n')) {
        if (!line) continue
        try {
          const change: unknown = JSON.parse(line)
          if (isChange(change)) changes.push(change)
          else bad++
        } catch {
          bad++
        }
      }
      if (bad) report.problems.push(`${key}: ${bad} unreadable ${bad === 1 ? 'line' : 'lines'}`)
      done.push(key)
      // Another browser profile writes under this device's id, so it was copied from this one.
      if (dev === device) cloned = true
    }
  }
  report.applied = await repos.sync.apply(changes)
  await repos.sync.markApplied(done)
  if (cloned) {
    const fresh = crypto.randomUUID()
    repos.sync.start(fresh)
    await repos.sync.setState('device', fresh)
    await repos.sync.setState('seq', 0)
  }

  // MIDI files, stored by content so every name is written once.
  const remote = new Set(await folder.files(['midi']))
  for (const location of await repos.locations.all()) {
    const name = `${location.hash}.mid`
    if (location.source === 'sync' || remote.has(name)) continue
    const data = await opts.readMidi(location.hash).catch(() => null)
    if (!data || data.byteLength > MAX_MIDI_BYTES) continue
    await folder.write(['midi'], name, new Blob([data]))
    remote.add(name)
    report.uploaded++
  }

  for (const piece of await repos.pieces.missing()) {
    const name = `${piece.hash}.mid`
    if (!remote.has(name)) continue
    let data = await repos.files.get(piece.hash)
    if (!data) {
      const blob = await folder.read(['midi'], name)
      if (!blob || blob.size > MAX_MIDI_BYTES) continue
      data = await blob.arrayBuffer()
      // Not fully synced yet: try again next round.
      if ((await opts.sha256(data)) !== piece.hash) continue
      await repos.files.put(piece.hash, data)
    }
    await repos.locations.put({ hash: piece.hash, source: 'sync', path: '' })
    report.downloaded++
  }

  return report
}
