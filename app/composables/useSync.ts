import { handleFolder, syncOnce, type SyncReport } from '#db/sync'

/** Quiet time after a local change before it is pushed. */
const PUSH_DELAY_MS = 5000
const INTERVAL_MS = 5 * 60_000
/** Coming back to the window syncs at most this often. */
const FOCUS_MIN_GAP_MS = 30_000
const LOCK = 'peanu-reeves-sync'

function deviceName(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  return nav.userAgentData?.platform || navigator.platform || 'Unknown device'
}

function createSync() {
  const repos = useRepos()
  const library = useLibrary()

  const folder = shallowRef<FileSystemDirectoryHandle | null>(null)
  const permission = ref<PermissionState | null>(null)
  const running = ref(false)
  const lastSyncAt = ref<number | null>(null)
  const report = shallowRef<SyncReport | null>(null)
  const error = ref<string | null>(null)
  const pending = ref(0)
  const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window

  let again = false

  async function readMidi(hash: string): Promise<ArrayBuffer | null> {
    return library.loadBytes({ hash }, { prompt: false }).catch(() => null)
  }

  async function round(handle: FileSystemDirectoryHandle): Promise<SyncReport> {
    const run = () =>
      syncOnce(repos, handleFolder(handle), {
        readMidi,
        sha256: sha256Hex,
        deviceName: deviceName(),
      })
    // Two tabs share one database and device id, so only one of them syncs at a time.
    return navigator.locks ? navigator.locks.request(LOCK, run) : run()
  }

  /** Syncs now, or once more right after the round that is already running. */
  async function run(): Promise<void> {
    const handle = folder.value
    if (!handle || !repos.sync.enabled) return
    if (running.value) return void (again = true)

    permission.value = await handle.queryPermission({ mode: 'readwrite' })
    if (permission.value !== 'granted') return

    running.value = true
    try {
      do {
        again = false
        report.value = await round(handle)
        lastSyncAt.value = Date.now()
        error.value = null
        await repos.sync.setState('lastSyncAt', lastSyncAt.value)
        if (report.value.applied || report.value.downloaded) await library.refresh()
      } while (again)
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      running.value = false
      pending.value = await repos.sync.pending()
    }
  }

  const pushSoon = useDebounceFn(() => void run(), PUSH_DELAY_MS)
  repos.sync.hooks.tracked = () => {
    pending.value++
    void pushSoon()
  }

  useIntervalFn(() => document.visibilityState === 'visible' && void run(), INTERVAL_MS)
  useEventListener(window, 'focus', () => {
    if (!lastSyncAt.value || Date.now() - lastSyncAt.value > FOCUS_MIN_GAP_MS) void run()
  })

  async function init(): Promise<void> {
    folder.value = (await repos.sync.getState<FileSystemDirectoryHandle>('folder')) ?? null
    lastSyncAt.value = (await repos.sync.getState<number>('lastSyncAt')) ?? null
    pending.value = await repos.sync.pending()
    await library.ready
    await run()
  }

  /** Starts syncing with a folder the user picks. Call from a click. */
  async function choose(): Promise<void> {
    let handle: FileSystemDirectoryHandle
    try {
      handle = await window.showDirectoryPicker({ id: 'sync-folder', mode: 'readwrite' })
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) error.value = String(e)
      return
    }

    // A fresh id each time, so files this browser wrote under an earlier id are read like
    // any other device's.
    const device = crypto.randomUUID()
    await repos.sync.reset()
    await repos.sync.setState('folder', handle)
    await repos.sync.setState('device', device)
    await repos.sync.setState('seq', 0)
    repos.sync.start(device)
    await repos.sync.seed()
    folder.value = handle
    await run()
  }

  /** Asks for access again after a browser restart. Call from a click. */
  async function resume(): Promise<void> {
    if (!folder.value) return
    permission.value = await folder.value.requestPermission({ mode: 'readwrite' })
    await run()
  }

  async function stop(): Promise<void> {
    await repos.sync.stop()
    for (const key of ['folder', 'device', 'seq', 'lastSyncAt'])
      await repos.sync.setState(key, undefined)
    folder.value = null
    permission.value = null
    report.value = null
    lastSyncAt.value = null
    error.value = null
    pending.value = 0
  }

  const ready = init().catch((e: unknown) => (error.value = String(e)))

  return {
    supported,
    folder,
    permission,
    running,
    lastSyncAt,
    report,
    error,
    pending,
    ready,
    run,
    choose,
    resume,
    stop,
  }
}

export type Sync = ReturnType<typeof createSync>

let sync: Sync | undefined

/** Lives for the whole app, so syncing carries on while moving between pages. */
export function useSync(): Sync {
  return (sync ??= effectScope(true).run(createSync)!)
}
