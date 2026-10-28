<script setup lang="ts">
import type { PieceSummary } from '#db/repositories'
import type { Piece, Recording, Take } from '#db/schema'
import { isEditable } from '#engine/midi-input/keyboard'

/** The part of the practice view's stored options the Continue section shows. */
interface StoredOptions {
  loopOn?: boolean
  loopFrom?: number
  loopTo?: number
  ramp?: { enabled?: boolean }
  rampProgress?: Record<string, number>
}

const library = useLibrary()
const { pieces, folder, permission, scanning, progress, error, supportsFolders } = library
const repos = useRepos()
const settings = useSettings()
const backups = useBackup()
const hasData = computed(() => summaries.value.size > 0 || recordings.value.length > 0)

const summaries = shallowRef(new Map<string, PieceSummary>())
const recordings = shallowRef<Recording[]>([])
const starredTakes = shallowRef<Take[]>([])
const starredCounts = shallowRef(new Map<string, number>())
const recentTakes = shallowRef<Take[]>([])
const query = ref('')
/** Imported piece waiting for a second click to be removed. */
const confirmRemove = refAutoReset<string | null>(null, 4000)

async function removePiece(piece: Piece): Promise<void> {
  if (confirmRemove.value !== piece.hash) {
    confirmRemove.value = piece.hash
    return
  }
  confirmRemove.value = null
  await library.remove(piece)
  await loadSummaries()
}
/** Shown for a few seconds after a scan finishes. */
const scanSummary = refAutoReset<string | null>(null, 5000)

const dropZone = useTemplateRef<HTMLElement>('dropZone')
const { isOverDropZone } = useDropZone(dropZone, {
  onDrop: (files) => files && library.importFiles(files),
})
const { open: openFiles, onChange } = useFileDialog({ accept: '.mid,.midi', multiple: true })
onChange((files) => files && library.importFiles([...files]))

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list = q
    ? pieces.value.filter((p) => `${p.title} ${p.path}`.toLowerCase().includes(q))
    : pieces.value
  return list.toSorted(
    (a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0) || a.title.localeCompare(b.title),
  )
})

const recentPiece = computed(() =>
  pieces.value
    .filter((p) => p.lastPlayedAt)
    .toSorted((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))
    .at(0),
)
const recentOptions = useLocalStorage<StoredOptions>(
  () => `practice:${recentPiece.value?.hash ?? ''}`,
  {},
  { writeDefaults: false },
)

const recent = computed(() => {
  const piece = recentPiece.value
  if (!piece) return null

  const summary = summaries.value.get(piece.hash)
  const o = recentOptions.value
  const loop =
    o.loopOn && o.loopFrom !== undefined && o.loopTo !== undefined
      ? { startMeasure: o.loopFrom - 1, endMeasure: o.loopTo - 1 }
      : null
  const ramp =
    loop && o.ramp?.enabled
      ? o.rampProgress?.[`${loop.startMeasure}-${loop.endMeasure}`]
      : undefined

  return {
    piece,
    loop,
    ramp,
    weak: summary?.weakBars ?? [],
    lastPass: summary?.last?.accuracy ?? null,
    lastTake: recentTakes.value[0],
    takeCount: recentTakes.value.length,
  }
})

const showSkeleton = computed(() => !pieces.value.length && scanning.value)
const empty = computed(() => !pieces.value.length && !scanning.value && !query.value)

const titleOf = (hash: string): string =>
  pieces.value.find((p) => p.hash === hash)?.title ?? 'Removed piece'

function barsOf(t: Take): string {
  return t.startMeasure === undefined
    ? 'whole piece'
    : `bars ${t.startMeasure + 1}–${(t.endMeasure ?? t.startMeasure) + 1}`
}

const isWeak = (p: Piece): boolean => {
  const best = summaries.value.get(p.hash)?.best
  return best !== null && best !== undefined && best < 0.85
}

async function loadSummaries() {
  summaries.value = await repos.attempts.summaryByPiece()
  recordings.value = await repos.recordings.all()
  starredTakes.value = await repos.takes.starred()
  starredCounts.value = await repos.takes.starredCounts()
}

watch(
  recentPiece,
  async (p) => {
    recentTakes.value = p ? await repos.takes.forPiece(p.hash) : []
  },
  { immediate: true },
)

watch(scanning, async (now, was) => {
  if (!was || now) return
  await loadSummaries()

  const parts = [
    progress.added && `${progress.added} new`,
    progress.updated && `${progress.updated} updated`,
    progress.removed && `${progress.removed} removed`,
  ].filter(Boolean)
  scanSummary.value = parts.length ? parts.join(' · ') : 'Up to date'
})

function pageKey(e: KeyboardEvent, action: () => void) {
  if (isEditable(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
  e.preventDefault()
  action()
}

onKeyStroke(['f', 'F'], (e) => pageKey(e, () => void navigateTo('/free')))
onKeyStroke('Enter', (e) => {
  const p = recent.value?.piece
  if (p) pageKey(e, () => void navigateTo(`/practice/${p.hash}`))
})

onMounted(async () => {
  await library.ready
  await library.refresh()
  await loadSummaries()
})
</script>

<template>
  <main ref="dropZone" class="library" :class="{ dropping: isOverDropZone }">
    <section v-if="recent" class="continue" aria-labelledby="continue-h">
      <PieceThumb
        class="hero-thumb"
        :thumb="recent.piece.thumb"
        :weak="recent.weak"
        :loop="recent.loop"
        :height="112"
      />

      <div class="continue-text">
        <span id="continue-h" class="eyebrow"
          >Continue · {{ formatAgo(recent.piece.lastPlayedAt).toLowerCase() }}</span
        >
        <h1>{{ recent.piece.title }}</h1>
        <p class="muted">
          <template v-if="recent.loop"
            >Looping bars
            <b>{{ recent.loop.startMeasure + 1 }}–{{ recent.loop.endMeasure + 1 }}</b> ·
          </template>
          <template v-if="recent.ramp !== undefined"
            >tempo ramp at <b>{{ Math.round(recent.ramp * 100) }}%</b> ·
          </template>
          <template v-if="recent.lastPass !== null"
            >last pass <b>{{ formatPercent(recent.lastPass) }}</b> ·
          </template>
          <template v-if="recent.takeCount"
            >{{ recent.takeCount }} {{ recent.takeCount === 1 ? 'take' : 'takes' }}</template
          >
          <template v-else>not practised yet</template>
        </p>
      </div>

      <div class="continue-actions">
        <div class="row">
          <NuxtLink
            v-if="recent.lastTake"
            :to="`/practice/${recent.piece.hash}?take=${recent.lastTake.id}`"
            class="btn pill"
            >Last take</NuxtLink
          >
          <NuxtLink
            v-if="recent.weak.length"
            :to="`/practice/${recent.piece.hash}?drill=1`"
            class="btn pill"
            >Drill weak bars</NuxtLink
          >
          <NuxtLink :to="`/practice/${recent.piece.hash}`" class="btn pill primary"
            >Resume practice</NuxtLink
          >
        </div>
        <span class="muted small"><kbd>Enter</kbd> continues · <kbd>F</kbd> free play</span>
      </div>
    </section>

    <div v-if="hasData && backups.due.value" class="notice backup-reminder" role="status">
      <span
        ><b>{{ settings.lastBackupAt ? 'No backup for a while.' : 'No backup yet.' }}</b> Your
        practice history lives only in this browser.</span
      >
      <span class="spacer" />
      <button class="ghost small" @click="backups.snooze()">Later</button>
      <button class="primary small" @click="backups.save()">Save backup</button>
    </div>

    <div class="columns">
      <section class="pieces" aria-labelledby="pieces-h">
        <div class="tools">
          <input
            v-model="query"
            type="search"
            placeholder="Search pieces"
            aria-label="Search pieces"
          />
          <span class="spacer" />
          <span v-if="folder" class="muted small folder-status">
            <span class="num">{{ folder.name }}</span> ·
            <template v-if="permission !== 'granted'">needs permission again</template>
            <span v-else-if="scanning" role="status"
              >checking {{ progress.done }} of {{ progress.total || '…' }} files{{
                progress.added ? ` · ${progress.added} new` : ''
              }}</span
            >
            <span v-else-if="scanSummary" role="status">{{ scanSummary }}</span>
            <template v-else>checked on launch</template>
          </span>
          <button v-if="!folder" :disabled="!supportsFolders" @click="library.linkFolder()">
            Link folder
          </button>
          <template v-else>
            <button v-if="permission !== 'granted'" @click="library.reconnect()">Reconnect</button>
            <button v-else class="ghost" :disabled="scanning" @click="library.scan()">
              Rescan
            </button>
            <button class="ghost" @click="library.unlinkFolder()">Unlink</button>
          </template>
          <button @click="openFiles()">Import MIDI</button>
        </div>

        <div
          v-if="scanning && progress.total"
          class="scan-bar"
          role="progressbar"
          :aria-valuenow="progress.done"
          :aria-valuemax="progress.total"
          aria-label="Checking folder"
        >
          <i :style="{ width: `${(progress.done / progress.total) * 100}%` }" />
        </div>

        <p v-if="error" class="notice error">{{ error }}</p>

        <template v-if="filtered.length">
          <div class="list-head">
            <span class="legend"><i aria-hidden="true" />weak bars</span>
            <h2 id="pieces-h">Pieces · {{ filtered.length }}</h2>
            <span>Best</span>
            <span>Last</span>
            <span />
          </div>

          <div v-for="piece in filtered" :key="piece.hash" class="piece-row">
            <PieceThumb
              :thumb="piece.thumb"
              :weak="summaries.get(piece.hash)?.weakBars"
              :dim="!piece.lastPlayedAt"
              :height="44"
            />
            <div class="piece-title">
              <NuxtLink :to="`/practice/${piece.hash}`" class="title">{{ piece.title }}</NuxtLink>
              <span class="meta">
                {{ formatDuration(piece.durationSec) }} · {{ piece.trackCount }}
                {{ piece.trackCount === 1 ? 'track' : 'tracks' }}
                <NuxtLink
                  v-if="starredCounts.get(piece.hash)"
                  :to="`/practice/${piece.hash}?takes=1`"
                  class="starred"
                  >★ {{ starredCounts.get(piece.hash) }} starred
                  {{ starredCounts.get(piece.hash) === 1 ? 'take' : 'takes' }}</NuxtLink
                >
              </span>
            </div>
            <span class="num best" :class="{ weak: isWeak(piece) }">{{
              formatPercent(summaries.get(piece.hash)?.best)
            }}</span>
            <span class="muted">{{ formatAgo(piece.lastPlayedAt) }}</span>
            <span class="row-actions">
              <button
                v-if="piece.source !== 'folder'"
                class="ghost round remove"
                :class="{ confirm: confirmRemove === piece.hash }"
                :aria-label="
                  confirmRemove === piece.hash
                    ? `Click again to remove ${piece.title}`
                    : `Remove ${piece.title} from the library`
                "
                :title="
                  confirmRemove === piece.hash ? 'Click again to remove' : 'Remove from library'
                "
                @click="removePiece(piece)"
              >
                <svg
                  v-if="confirmRemove !== piece.hash"
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
                </svg>
                <span v-else>Remove?</span>
              </button>
              <NuxtLink
                :to="`/practice/${piece.hash}?mode=listen`"
                class="btn ghost round"
                :aria-label="`Listen to ${piece.title}`"
                title="Listen"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4 14v-2a8 8 0 0116 0v2" />
                  <rect x="3" y="14" width="4" height="6" rx="1.5" />
                  <rect x="17" y="14" width="4" height="6" rx="1.5" />
                </svg>
              </NuxtLink>
              <NuxtLink :to="`/practice/${piece.hash}`" class="btn pill">Practice</NuxtLink>
            </span>
          </div>
        </template>

        <div v-else-if="showSkeleton" class="skeleton" aria-hidden="true">
          <div v-for="i in 4" :key="i" class="sk-row">
            <i class="sk-thumb" /><i class="sk-line" /><i class="sk-short" />
          </div>
        </div>

        <section v-else-if="empty" class="welcome" aria-labelledby="welcome-h">
          <h2 id="welcome-h">Add your music</h2>
          <p class="muted">
            Peanu Reeves practises with MIDI files. Everything stays on this device; nothing is
            uploaded.
          </p>
          <ol class="ways">
            <li v-if="supportsFolders && !folder">
              <b>Link a folder</b>
              <span class="muted">
                Pick the folder you keep your MIDI files in. It is checked on every launch, so new
                and edited files show up by themselves.
              </span>
              <button class="primary" @click="library.linkFolder()">Link folder</button>
            </li>
            <li>
              <b>Import files</b>
              <span class="muted">Choose single .mid files; they are stored in the app.</span>
              <button :class="{ primary: !supportsFolders || !!folder }" @click="openFiles()">
                Import MIDI
              </button>
            </li>
            <li>
              <b>Drop them here</b>
              <span class="muted"
                >Drag .mid files from your file manager anywhere onto this page.</span
              >
            </li>
          </ol>
        </section>

        <p v-else class="muted">No pieces match “{{ query }}”.</p>

        <p v-if="pieces.length" class="drop muted">Drop .mid files anywhere to add them</p>
      </section>

      <aside class="side" aria-label="Free play and recordings">
        <NuxtLink to="/free" class="free-card">
          <span class="free-head">
            <span class="free-title">Free play</span>
            <span class="start"><i aria-hidden="true" />Start<kbd>F</kbd></span>
          </span>
          <span class="muted"
            >No score, no scoring. Just the keys and a trail of what you play. The last ten minutes
            are always kept; press R to record.</span
          >
        </NuxtLink>

        <section v-if="recordings.length" aria-labelledby="rec-h">
          <h2 id="rec-h" class="block-title">Recordings · {{ recordings.length }}</h2>
          <div v-for="r in recordings" :key="r.id" class="rec-row">
            <PieceThumb :thumb="r.thumb" :height="40" />
            <NuxtLink :to="`/free?recording=${r.id}`" class="rec-text">
              <span class="rec-title">{{ r.title }}</span>
              <span class="muted small"
                >{{ formatDuration(r.durationSec) }} ·
                {{ formatAgo(r.createdAt).toLowerCase() }}</span
              >
            </NuxtLink>
            <NuxtLink
              :to="`/free?recording=${r.id}`"
              class="btn round"
              :aria-label="`Open ${r.title}`"
              title="Play, rename, export"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M7 4.5v15l12-7.5z" />
              </svg>
            </NuxtLink>
          </div>
        </section>

        <section v-if="starredTakes.length" aria-labelledby="star-h">
          <h2 id="star-h" class="block-title">Starred takes · {{ starredTakes.length }}</h2>
          <div v-for="t in starredTakes" :key="t.id" class="star-row">
            <div class="rec-text">
              <span class="rec-title">{{ titleOf(t.hash) }}</span>
              <span class="muted small"
                >{{ barsOf(t) }} · {{ Math.round(t.tempo * 100) }}% ·
                {{ formatAgo(t.startedAt).toLowerCase() }}</span
              >
            </div>
            <span class="num acc">{{ formatPercent(t.accuracy) }}</span>
            <NuxtLink
              :to="`/practice/${t.hash}?take=${t.id}`"
              class="btn ghost round"
              :aria-label="`Play starred take of ${titleOf(t.hash)}`"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M7 4.5v15l12-7.5z" />
              </svg>
            </NuxtLink>
          </div>
        </section>
      </aside>
    </div>
  </main>
</template>

<style scoped>
.library {
  max-width: 1440px;
  margin: 0 auto;
  padding: 0 clamp(16px, 6vw, 96px) 64px;
}

.dropping {
  outline: 2px dashed var(--text);
  outline-offset: -8px;
  border-radius: var(--radius);
}

p {
  margin: 0;
}

b {
  font-weight: 400;
  color: var(--hi);
}

.small {
  font-size: 14px;
}

kbd {
  font-family: var(--mono);
  font-size: 0.8em;
  padding: 1px 6px;
  border-radius: 5px;
  border: 1px solid currentColor;
  opacity: 0.75;
}

.btn.pill,
.pill {
  height: 52px;
  padding: 0 22px;
  border-radius: 26px;
  font-size: 16px;
}

.btn.round {
  width: 44px;
  height: 44px;
  padding: 0;
  justify-content: center;
  border-radius: 22px;
}

/* Continue. */
.continue {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr) auto;
  align-items: center;
  gap: 48px;
  padding: 32px 0;
  border-bottom: 1px solid var(--line);
}

.hero-thumb {
  border-radius: 10px;
}

.continue-text {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.eyebrow {
  font-size: 14px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--faint);
}

.continue h1 {
  font-size: 56px;
  font-weight: 200;
  letter-spacing: -0.035em;
  line-height: 1;
  color: var(--hi);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.continue-text p {
  font-size: 18px;
}

.continue-actions {
  display: grid;
  justify-items: end;
  gap: 10px;
}

/* Two columns: pieces, then free play and recordings. */
.columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 400px;
  gap: 56px;
  padding-top: 32px;
}

.tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 20px;
}

.tools input {
  height: 40px;
  width: min(280px, 100%);
}

.folder-status {
  white-space: nowrap;
}

.scan-bar {
  height: 2px;
  margin: -12px 0 16px;
  background: var(--line);
  border-radius: 1px;
  overflow: hidden;
}

.scan-bar i {
  display: block;
  height: 100%;
  background: var(--text);
  transition: width 0.2s;
}

.list-head,
.piece-row {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr) 56px 96px 210px;
  gap: 20px;
  align-items: center;
  border-bottom: 1px solid var(--line);
}

.list-head {
  align-items: end;
  padding-bottom: 12px;
  font-size: 13px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--faint);
}

.list-head h2 {
  font-size: 13px;
  font-weight: 500;
}

.legend {
  display: flex;
  align-items: center;
  gap: 8px;
  letter-spacing: 0;
  text-transform: none;
}

.legend i {
  width: 14px;
  height: 2px;
  border-radius: 1px;
  background: var(--danger);
}

.piece-row {
  min-height: 84px;
  font-size: 16px;
  color: var(--muted);
}

.piece-title {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.title {
  font-size: 20px;
  font-weight: 300;
  letter-spacing: -0.01em;
  color: var(--hi);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.title:hover {
  text-decoration: underline;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 14px;
}

.starred {
  color: var(--text);
  text-decoration: none;
}

.best {
  color: var(--hi);
}

.best.weak {
  color: var(--danger);
}

.row-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.remove {
  width: 44px;
  height: 44px;
  padding: 0;
  justify-content: center;
  border-radius: 22px;
  color: var(--muted);
}

.remove.confirm {
  width: auto;
  padding: 0 14px;
  color: var(--danger);
  border-color: var(--danger);
}

.row-actions .pill {
  height: 44px;
  font-size: 15px;
}

.backup-reminder {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.drop {
  margin-top: 24px;
  text-align: center;
  padding: 18px;
  border: 1.5px dashed var(--border);
  border-radius: var(--radius);
  font-size: 0.85rem;
}

/* Right column. */
.side {
  display: grid;
  align-content: start;
  gap: 28px;
}

.free-card {
  display: grid;
  gap: 10px;
  padding: 20px 20px 18px;
  border-radius: 16px;
  border: 1px solid var(--border);
  color: var(--text);
  text-decoration: none;
}

.free-card:hover {
  border-color: var(--faint);
}

.free-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.free-title {
  font-size: 28px;
  font-weight: 300;
  letter-spacing: -0.02em;
  color: var(--hi);
}

.start {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 8px 0 16px;
  border-radius: 22px;
  background: var(--inv);
  color: var(--inv-text);
  font-size: 15px;
  font-weight: 500;
}

.start i {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--danger);
}

.free-card .muted {
  font-size: 15px;
  line-height: 1.45;
}

.block-title {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--faint);
}

.rec-row,
.star-row {
  display: grid;
  align-items: center;
  border-bottom: 1px solid var(--line);
}

.rec-row {
  grid-template-columns: 112px minmax(0, 1fr) 44px;
  gap: 14px;
  min-height: 76px;
}

.star-row {
  grid-template-columns: minmax(0, 1fr) auto 44px;
  gap: 12px;
  min-height: 60px;
}

.rec-text {
  display: grid;
  gap: 3px;
  min-width: 0;
  color: inherit;
  text-decoration: none;
}

.rec-title {
  font-size: 17px;
  font-weight: 300;
  color: var(--hi);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.acc {
  font-size: 22px;
  font-weight: 300;
  color: var(--hi);
}

/* First run and loading. */
.welcome {
  display: grid;
  gap: 12px;
}

.welcome h2 {
  font-size: 28px;
  font-weight: 300;
}

.ways {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.ways li {
  display: grid;
  align-content: start;
  justify-items: start;
  gap: 8px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.ways .muted {
  font-size: 0.9rem;
  line-height: 1.45;
}

.skeleton {
  display: grid;
}

.sk-row {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 18px 0;
  border-bottom: 1px solid var(--line);
}

.sk-row i {
  display: block;
  height: 12px;
  border-radius: 6px;
  background: var(--surface-2);
  animation: pulse 1.4s ease-in-out infinite;
}

.sk-thumb {
  width: 120px;
  height: 44px !important;
}

.sk-line {
  width: 220px;
}

.sk-short {
  width: 80px;
}

@keyframes pulse {
  50% {
    opacity: 0.45;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sk-row i {
    animation: none;
  }
}

@media (max-width: 1100px) {
  .columns {
    grid-template-columns: 1fr;
  }
  .continue {
    grid-template-columns: 200px minmax(0, 1fr);
  }
  .continue-actions {
    grid-column: 1 / -1;
    justify-items: start;
  }
}

@media (max-width: 720px) {
  .continue {
    grid-template-columns: 1fr;
    gap: 20px;
  }
  .continue h1 {
    font-size: 40px;
  }
  .list-head,
  .piece-row {
    grid-template-columns: minmax(0, 1fr) 56px 120px;
  }
  .list-head > :first-child,
  .piece-row > :first-child,
  .list-head > :nth-child(4),
  .piece-row > :nth-child(4) {
    display: none;
  }
}
</style>
