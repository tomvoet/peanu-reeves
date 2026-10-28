<script setup lang="ts">
import type { Piece, Section } from '#db/schema'
import { MIDDLE_C } from '#engine/song/hand-split'
import { playability } from '#engine/song/hand-separation'
import { parseSong } from '#engine/song/parse'
import type { Hand, HandSplit, HandSplitMode, Song } from '#engine/types'

interface SplitModeOption {
  mode: HandSplitMode
  label: string
  title?: string
}

const SPLIT_MODES: readonly SplitModeOption[] = [
  {
    mode: 'auto',
    label: 'Automatic',
    title: "The file's tracks when they name the hands or there are exactly two, otherwise Smart",
  },
  {
    mode: 'smart',
    label: 'Smart',
    title: 'Works out the hands from the notes: reach, movement and rhythm of each hand',
  },
  { mode: 'tracks', label: 'By track' },
  { mode: 'pitch', label: 'By pitch' },
]

const MODE_TEXT = {
  tracks: "the file's tracks",
  smart: 'smart separation, worked out from the notes',
  pitch: 'a split at a fixed pitch',
  auto: '',
} as const satisfies Record<HandSplitMode, string>

const route = useRoute()
const hash = String(route.params.hash)
const repos = useRepos()
const library = useLibrary()

const piece = ref<Piece>()
/** Where the file is on this device. */
const path = ref<string>()
const song = shallowRef<Song>()
const bytes = shallowRef<ArrayBuffer>()
const sections = ref<Section[]>([])
const split = ref<HandSplit>({ mode: 'auto' })
const hasOverride = ref(false)
const error = ref<string | null>(null)
const saved = refAutoReset(false, 1500)
const confirmRemove = refAutoReset(false, 4000)

const playableTracks = computed(() => song.value?.tracks.filter((t) => t.noteCount > 0) ?? [])
const handCounts = computed(() => ({
  L: song.value?.notes.filter((n) => n.hand === 'L').length ?? 0,
  R: song.value?.notes.filter((n) => n.hand === 'R').length ?? 0,
}))
const fixCount = computed(() => Object.keys(split.value.fixes ?? {}).length)
const issues = computed(() => (song.value ? issuesOf(song.value) : 0))
const smartIssues = computed(() =>
  bytes.value && song.value?.handSplit.mode !== 'smart'
    ? issuesOf(parseSong(bytes.value, { handSplit: { mode: 'smart' } }))
    : null,
)

function issuesOf(s: Song) {
  const r = playability(
    s.notes,
    s.notes.map((n) => n.hand),
  )
  return r.spans + r.crowded + r.leaps
}

function setMode(mode: HandSplitMode) {
  const fixes = split.value.fixes
  if (mode === 'pitch')
    split.value = { mode, splitPitch: song.value?.handSplit.splitPitch ?? MIDDLE_C, fixes }
  else if (mode === 'tracks')
    split.value = { mode, trackMap: { ...song.value?.handSplit.trackMap }, fixes }
  else split.value = { mode, fixes }
}

function setTrackHand(track: number, hand: Hand) {
  split.value = {
    mode: 'tracks',
    trackMap: { ...song.value?.handSplit.trackMap, [track]: hand },
    fixes: split.value.fixes,
  }
}

function clearFixes() {
  split.value = { ...split.value, fixes: undefined }
}

async function save() {
  if (split.value.mode === 'auto') {
    await repos.overrides.remove(hash)
    hasOverride.value = false
  } else {
    const existing = await repos.overrides.get(hash)
    const handSplit: HandSplit = JSON.parse(JSON.stringify(split.value))
    await repos.overrides.put({ ...existing, hash, handSplit })
    hasOverride.value = true
  }

  saved.value = true
  void library.refreshThumb(hash)
}

async function deleteSection(section: Section) {
  if (section.id === undefined) return
  await repos.sections.remove(section.id)
  sections.value = await repos.sections.forPiece(hash)
}

async function removePiece() {
  if (!piece.value) return
  if (!confirmRemove.value) {
    confirmRemove.value = true
    return
  }

  await library.remove(piece.value)
  await navigateTo('/')
}

watchEffect(() => {
  if (bytes.value) song.value = parseSong(bytes.value, { handSplit: toRaw(split.value) })
})

onMounted(async () => {
  try {
    await library.ready
    piece.value = await repos.pieces.get(hash)
    if (!piece.value) throw new Error('This piece is not in the library.')
    path.value = (await repos.locations.get(hash))?.path
    bytes.value = await library.loadBytes(piece.value)

    const override = await repos.overrides.get(hash)
    hasOverride.value = !!override
    split.value = override?.handSplit ?? { mode: 'auto' }
    sections.value = await repos.sections.forPiece(hash)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
})
</script>

<template>
  <main class="page">
    <div class="head">
      <NuxtLink to="/" class="btn ghost icon" aria-label="Back to library">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </NuxtLink>
      <div class="grow">
        <h1>{{ piece?.title ?? 'Piece' }}</h1>
        <p v-if="piece" class="muted">
          {{ formatDuration(piece.durationSec) }} · {{ song?.measures.length ?? '–' }} bars ·
          {{ piece.trackCount }} {{ piece.trackCount === 1 ? 'track' : 'tracks' }}
        </p>
      </div>
      <NuxtLink v-if="piece" :to="`/practice/${hash}?mode=listen`" class="btn">Listen</NuxtLink>
      <NuxtLink v-if="piece" :to="`/practice/${hash}`" class="btn primary">Practice</NuxtLink>
    </div>

    <p v-if="error" class="notice error">{{ error }}</p>
    <p v-if="piece?.revisedAt" class="notice">
      This file changed on disk {{ formatAgo(piece.revisedAt).toLowerCase() }}. Its practice history
      and sections were kept<template v-if="hasOverride"
        >; check that the hand split below still fits</template
      >.
    </p>

    <section v-if="song" class="card grid">
      <div>
        <h2>Hand split</h2>
        <p class="muted small">Which notes count as left and right hand.</p>
      </div>
      <div class="segmented">
        <button
          v-for="m in SPLIT_MODES"
          :key="m.mode"
          :class="{ active: split.mode === m.mode }"
          :title="m.title"
          :disabled="m.mode === 'tracks' && playableTracks.length < 2"
          @click="setMode(m.mode)"
        >
          {{ m.label }}
        </button>
      </div>
      <p class="muted">
        Using <b>{{ MODE_TEXT[song.handSplit.mode] }}</b
        >: <span class="hand-L">{{ handCounts.L }} left</span>,
        <span class="hand-R">{{ handCounts.R }} right</span> notes.
      </p>
      <p v-if="issues" class="notice row">
        <span
          >{{ issues }} {{ issues === 1 ? 'spot needs' : 'spots need' }} one hand to reach further
          than a tenth, hold more than five notes or jump impossibly fast<template
            v-if="smartIssues !== null"
            >; the smart split has {{ smartIssues }}</template
          >.</span
        >
        <span class="spacer" />
        <button v-if="smartIssues !== null && smartIssues < issues" @click="setMode('smart')">
          Try smart
        </button>
      </p>
      <p class="muted small">
        <template v-if="fixCount">
          {{ fixCount }} {{ fixCount === 1 ? 'note was' : 'notes were' }} corrected by hand.
          <button class="ghost" @click="clearFixes">Clear corrections</button>
        </template>
        <template v-else
          >Wrong in places? In the practice view, use “Fix hands” and click notes to move them to
          the other hand.</template
        >
      </p>

      <label v-if="split.mode === 'pitch'" class="field">
        <span>Notes below {{ pitchName(split.splitPitch ?? MIDDLE_C) }} go to the left hand</span>
        <input v-model.number="split.splitPitch" type="range" min="36" max="84" />
      </label>

      <table v-if="song.handSplit.mode === 'tracks'">
        <thead>
          <tr>
            <th>Track</th>
            <th>Notes</th>
            <th>Range</th>
            <th>Hand</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in song.tracks" :key="t.index">
            <td>{{ t.name }}</td>
            <td class="num">{{ t.noteCount }}</td>
            <td class="num muted">
              {{ t.noteCount ? `avg ${pitchName(Math.round(t.meanPitch))}` : '–' }}
            </td>
            <td>
              <div v-if="t.noteCount" class="segmented">
                <button
                  :class="{ active: song.handSplit.trackMap?.[t.index] === 'L' }"
                  @click="setTrackHand(t.index, 'L')"
                >
                  Left
                </button>
                <button
                  :class="{ active: song.handSplit.trackMap?.[t.index] !== 'L' }"
                  @click="setTrackHand(t.index, 'R')"
                >
                  Right
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="row">
        <button class="primary" @click="save">Save split</button>
        <span v-if="saved" class="muted">Saved</span>
        <span v-else-if="hasOverride" class="muted">This piece has a custom split.</span>
      </div>
    </section>

    <section v-if="song" class="card grid">
      <h2>Saved sections</h2>
      <p v-if="!sections.length" class="muted">Save loop sections from the practice view.</p>
      <table v-else>
        <tbody>
          <tr v-for="s in sections" :key="s.id">
            <td>{{ s.label }}</td>
            <td class="num muted">bars {{ s.startMeasure + 1 }}–{{ s.endMeasure + 1 }}</td>
            <td class="actions">
              <NuxtLink
                :to="`/practice/${hash}?loop=${s.startMeasure + 1}-${s.endMeasure + 1}`"
                class="btn ghost"
                >Practice</NuxtLink
              >
              <button class="ghost" @click="deleteSection(s)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="piece" class="card row">
      <div class="muted">
        <div v-if="path">{{ path }}</div>
        <div class="num hash">{{ hash }}</div>
      </div>
      <span class="spacer" />
      <NuxtLink :to="`/stats?piece=${hash}`" class="btn">Stats</NuxtLink>
      <button class="ghost" :class="{ danger: confirmRemove }" @click="removePiece">
        {{ confirmRemove ? 'Click again to remove' : 'Remove from library' }}
      </button>
    </section>
  </main>
</template>

<style scoped>
.page {
  max-width: 880px;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.grow {
  flex: 1 1 240px;
  min-width: 0;
}

h1 {
  font-size: 2rem;
  letter-spacing: -0.02em;
}

.icon {
  width: 40px;
  height: 40px;
  padding: 0;
  justify-content: center;
}

.small {
  font-size: 0.8rem;
  margin-top: 2px;
}

.danger {
  color: var(--danger);
}

.grid {
  display: grid;
  gap: 14px;
}

p {
  margin: 0;
}

.actions {
  text-align: right;
  white-space: nowrap;
}

.hash {
  font-size: 0.72rem;
  word-break: break-all;
}
</style>
