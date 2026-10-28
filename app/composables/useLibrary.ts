import type { LibraryPiece, Piece, PieceSource, PieceThumb } from '#db/schema'
import type { HandSplit } from '#engine/types'
import { parseSong, summarizeMidi } from '#engine/song/parse'
import { thumbnailOf } from '#engine/song/thumbnail'
import { promiseTimeout } from '@vueuse/core'
import { basename, extname } from 'pathe'
import { titleCase } from 'scule'

const MIDI_EXT = /\.midi?$/i
const WORD_SEPARATORS = /[_-]+/g

const isMidi = (name: string): boolean => MIDI_EXT.test(name)

/** Lets the browser paint between chunks of a long-running loop. */
const yieldToBrowser = (): Promise<void> => promiseTimeout(0)

const emptyProgress = () => ({ total: 0, done: 0, added: 0, updated: 0, removed: 0, finishedAt: 0 })

interface FileStamp {
  fileSize?: number
  fileModified?: number
}

function titleFrom(path: string, embedded: string): string {
  return embedded.trim() || titleCase(basename(path, extname(path)).replace(WORD_SEPARATORS, ' '))
}

async function* walk(
  dir: FileSystemDirectoryHandle,
  prefix = '',
): AsyncGenerator<[string, FileSystemFileHandle]> {
  for await (const entry of dir.values()) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.kind === 'directory') yield* walk(entry as FileSystemDirectoryHandle, path)
    else if (isMidi(entry.name)) yield [path, entry as FileSystemFileHandle]
  }
}

async function resolvePath(
  dir: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemFileHandle> {
  const parts = path.split('/')
  const file = parts.pop()!
  let current = dir
  for (const part of parts) current = await current.getDirectoryHandle(part)
  return current.getFileHandle(file)
}

function moveLocalOptions(from: string, to: string): void {
  try {
    const value = localStorage.getItem(`practice:${from}`)
    if (value !== null && localStorage.getItem(`practice:${to}`) === null)
      localStorage.setItem(`practice:${to}`, value)
    localStorage.removeItem(`practice:${from}`)
  } catch {}
}

function createLibrary() {
  const repos = useRepos()

  const pieces = ref<LibraryPiece[]>([])
  const folder = shallowRef<FileSystemDirectoryHandle | null>(null)
  const permission = ref<PermissionState | null>(null)
  const scanning = ref(false)
  const error = ref<string | null>(null)
  const progress = reactive(emptyProgress())
  const supportsFolders = typeof window !== 'undefined' && 'showDirectoryPicker' in window

  const refresh = async (): Promise<LibraryPiece[]> => (pieces.value = await repos.pieces.library())

  /**
   * Returns the content hash, whether the piece is new and whether it is new on this device.
   * A piece can exist without being on this device, e.g. after its file was removed from the folder.
   */
  async function register(
    data: ArrayBuffer,
    path: string,
    source: PieceSource,
    file: FileStamp = {},
  ): Promise<{ hash: string; created: boolean; linked: boolean }> {
    const hash = await sha256Hex(data)
    const [existing, location] = await Promise.all([
      repos.pieces.get(hash),
      repos.locations.get(hash),
    ])

    if (
      location?.path !== path ||
      location.source !== source ||
      location.fileSize !== file.fileSize ||
      location.fileModified !== file.fileModified
    ) {
      await repos.locations.put({ hash, source, path, ...file })
    }
    if (existing) return { hash, created: false, linked: !location }

    const summary = summarizeMidi(data)
    await repos.pieces.put({
      hash,
      title: titleFrom(path, summary.title),
      durationSec: summary.durationSec,
      trackCount: summary.trackCount,
      addedAt: Date.now(),
      thumb: makeThumb(data),
    })
    return { hash, created: true, linked: true }
  }

  function makeThumb(data: ArrayBuffer, handSplit?: HandSplit): PieceThumb | undefined {
    try {
      return thumbnailOf(parseSong(data, { handSplit }))
    } catch {
      return undefined
    }
  }

  /** Builds missing thumbnails one piece at a time, after everything else has loaded. */
  async function ensureThumbs() {
    for (const piece of pieces.value.filter((p) => !p.thumb)) {
      try {
        const data = await loadBytes(piece)
        const override = await repos.overrides.get(piece.hash)
        const thumb = makeThumb(data, override?.handSplit)
        if (!thumb) continue
        await repos.pieces.setThumb(piece.hash, thumb)
        piece.thumb = thumb
        pieces.value = [...pieces.value]
      } catch {
        // A folder file that cannot be read right now gets its thumbnail on a later launch.
      }
      await yieldToBrowser()
    }
  }

  /** Recomputes one piece's thumbnail, e.g. after its hand split changed. */
  async function refreshThumb(hash: string) {
    const piece = pieces.value.find((p) => p.hash === hash) ?? (await repos.pieces.get(hash))
    if (!piece) return
    const override = await repos.overrides.get(hash)
    const thumb = makeThumb(await loadBytes(piece), override?.handSplit)
    if (thumb) await repos.pieces.setThumb(hash, thumb)
    await refresh()
  }

  /**
   * Brings the library in line with the folder. Files whose size and modification time are
   * unchanged since the last scan are not read again, so a launch with no changes is quick.
   */
  async function scan() {
    if (!folder.value || permission.value !== 'granted' || scanning.value) return
    scanning.value = true
    error.value = null
    Object.assign(progress, emptyProgress())

    try {
      const files: [string, FileSystemFileHandle][] = []
      for await (const entry of walk(folder.value)) {
        files.push(entry)
        progress.total = files.length
      }

      const before = await repos.locations.folder()
      const byPath = new Map(before.map((l) => [l.path, l]))
      const seen = new Set<string>()
      const createdAt = new Map<string, string>()

      for (const [path, handle] of files) {
        try {
          const file = await handle.getFile()
          const known = byPath.get(path)
          if (known?.fileSize === file.size && known.fileModified === file.lastModified) {
            seen.add(known.hash)
          } else {
            const { hash, created, linked } = await register(
              await file.arrayBuffer(),
              path,
              'folder',
              { fileSize: file.size, fileModified: file.lastModified },
            )
            seen.add(hash)
            if (created) createdAt.set(path, hash)
            if (linked) {
              if (!known) progress.added++
              await refresh()
            }
          }
        } catch (e) {
          console.warn(`Skipping ${path}`, e)
        }
        progress.done++
        if (progress.done % 16 === 0) await yieldToBrowser()
      }

      for (const l of before) {
        if (seen.has(l.hash)) continue
        // Same path, new content: the file was edited, so its history moves along.
        const edited = createdAt.get(l.path)
        if (edited) {
          await repos.pieces.rehash(l.hash, edited)
          moveLocalOptions(l.hash, edited)
          progress.updated++
        } else {
          await repos.locations.remove(l.hash)
          progress.removed++
        }
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      scanning.value = false
      progress.finishedAt = Date.now()
      await refresh()
    }
  }

  /** Shows what is already known right away. Scanning happens afterwards in the background. */
  async function init() {
    folder.value = (await repos.settings.folder()) ?? null
    permission.value = folder.value ? await folder.value.queryPermission({ mode: 'read' }) : null
    await refresh()
  }

  async function background(): Promise<void> {
    await scan()
    void ensureThumbs()
  }

  async function linkFolder() {
    try {
      const handle = await window.showDirectoryPicker({ id: 'midi-library', mode: 'read' })
      await repos.settings.setFolder(handle)
      folder.value = handle
      permission.value = 'granted'
      await scan()
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) error.value = String(e)
    }
  }

  async function reconnect() {
    if (!folder.value) return
    permission.value = await folder.value.requestPermission({ mode: 'read' })
    await scan()
  }

  async function unlinkFolder() {
    await repos.settings.setFolder(null)
    folder.value = null
    permission.value = null
    await repos.locations.clearFolder()
    await refresh()
  }

  /** Adds MIDI files to the library and returns their hashes, in the given order. */
  async function importFiles(files: File[]): Promise<string[]> {
    const hashes: string[] = []
    for (const file of files.filter((f) => isMidi(f.name))) {
      const data = await file.arrayBuffer()
      const { hash } = await register(data, file.name, 'import')
      await repos.files.put(hash, data)
      hashes.push(hash)
    }
    await refresh()
    return hashes
  }

  /** With `prompt` off, a folder file that needs permission first fails instead of asking. */
  async function loadBytes(
    piece: Pick<Piece, 'hash'>,
    { prompt = true } = {},
  ): Promise<ArrayBuffer> {
    const location = await repos.locations.get(piece.hash)
    if (location?.source === 'folder' && folder.value) {
      try {
        if ((await folder.value.queryPermission({ mode: 'read' })) !== 'granted') {
          if (!prompt) throw new Error('The library folder needs permission again.')
          permission.value = await folder.value.requestPermission({ mode: 'read' })
        }
        const file = await (await resolvePath(folder.value, location.path)).getFile()
        return await file.arrayBuffer()
      } catch (e) {
        const stored = await repos.files.get(piece.hash)
        if (stored) return stored
        throw e
      }
    }

    const stored = await repos.files.get(piece.hash)
    if (stored) return stored
    if (location?.source === 'folder') throw new Error('No library folder is linked.')
    throw new Error('The file for this piece is not on this device.')
  }

  async function remove(piece: Piece) {
    await repos.pieces.remove(piece.hash)
    await refresh()
  }

  /** Resolves once the stored library and folder handle are loaded, not after the scan. */
  const ready = init()
    .catch((e: unknown) => (error.value = String(e)))
    .then(() => void background())

  return {
    pieces,
    folder,
    permission,
    scanning,
    progress,
    error,
    supportsFolders,
    ready,
    refresh,
    scan,
    linkFolder,
    reconnect,
    unlinkFolder,
    importFiles,
    loadBytes,
    remove,
    refreshThumb,
  }
}

export type Library = ReturnType<typeof createLibrary>

let library: Library | undefined

/** Lives for the whole app so the folder is scanned once per launch, not per page. */
export function useLibrary(): Library {
  return (library ??= effectScope(true).run(createLibrary)!)
}
