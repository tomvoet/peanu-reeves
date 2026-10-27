import type { Backup } from '#db/repositories'

const DAY_MS = 86_400_000
/** Practice data older than this without a backup triggers the library reminder. */
const REMIND_AFTER_MS = 14 * DAY_MS
const SNOOZE_MS = 3 * DAY_MS

const persisted = ref<boolean | null>(null)

/** Per-piece practice options kept in localStorage, which the backup carries along. */
function practiceOptions(): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    const value = key?.startsWith('practice:') ? localStorage.getItem(key) : null
    if (key && value !== null) out[key] = value
  }
  return out
}

export function useBackup() {
  const repos = useRepos()
  const settings = useSettings()
  const snoozedAt = useLocalStorage('backup:snoozedAt', 0)

  async function save(): Promise<Backup> {
    const backup = await repos.backup.export(practiceOptions())
    const day = new Date(backup.exportedAt).toISOString().slice(0, 10)
    downloadFile(`peanu-reeves-${day}.json`, 'application/json', JSON.stringify(backup))
    settings.lastBackupAt = backup.exportedAt
    return backup
  }

  const due = computed(() => {
    const now = Date.now()
    const last = settings.lastBackupAt
    return (!last || now - last > REMIND_AFTER_MS) && now - snoozedAt.value > SNOOZE_MS
  })

  const snooze = (): void => void (snoozedAt.value = Date.now())

  async function checkPersisted(): Promise<void> {
    persisted.value = (await navigator.storage?.persisted?.()) ?? null
  }

  /** Asks the browser not to clear this site's data when space runs low. */
  async function keep(): Promise<void> {
    persisted.value = (await navigator.storage?.persist?.()) ?? null
  }

  return { save, due, snooze, persisted: readonly(persisted), checkPersisted, keep }
}
