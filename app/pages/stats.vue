<script setup lang="ts">
import type { Attempt, Piece } from '#db/schema'
import { worstMeasures, type MeasureStats } from '#engine/stats/aggregate'
import type { HandMode } from '#engine/types'

interface BarTotals {
  hit: number
  wrong: number
  miss: number
  devSum: number
  devCount: number
}

type ScoredAttempt = Attempt & { accuracy: number }

const WEEK_MS = 7 * 86_400_000
const CLEAN = 0.9

const HAND_LABEL = {
  play: 'plays',
  auto: 'auto',
  ghost: 'ghost',
  hidden: 'hidden',
} as const satisfies Record<HandMode, string>

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const repos = useRepos()
const library = useLibrary()
const route = useRoute()
const router = useRouter()

const pieces = ref<Piece[]>([])
const attempts = ref<Attempt[]>([])
const focus = ref<number | null>(null)

const selected = computed({
  get: () => (typeof route.query.piece === 'string' ? route.query.piece : ''),
  set: (piece: string) => router.replace({ query: piece ? { piece } : {} }),
})

const focused = computed(() => attempts.value.find((a) => a.id === focus.value))

const tiles = computed(() => {
  const all = attempts.value
  const now = Date.now()
  const recent = all.filter((a) => now - a.startedAt < WEEK_MS)
  const full = all.filter(
    (a): a is ScoredAttempt => a.startMeasure === undefined && a.accuracy !== null,
  )
  const best = full.reduce<ScoredAttempt | null>(
    (b, a) => (b === null || a.accuracy > b.accuracy ? a : b),
    null,
  )
  const fastest = all
    .filter((a) => (a.accuracy ?? 0) >= CLEAN)
    .reduce((m, a) => Math.max(m, a.tempoFactor), 0)

  return [
    { label: 'Passes, last 7 days', value: String(recent.length), sub: `${all.length} in total` },
    {
      label: 'Wait-mode passes',
      value: String(all.filter((a) => a.mode === 'wait').length),
      sub: 'the rest were timed',
    },
    {
      label: 'Best full run',
      value: formatPercent(best?.accuracy),
      sub: best ? `at ${Math.round(best.tempoFactor * 100)}% tempo` : 'no full run yet',
    },
    {
      label: 'Fastest clean pass',
      value: fastest ? `${Math.round(fastest * 100)}%` : '–',
      sub: `tempo with ${CLEAN * 100}%+ accuracy`,
    },
  ]
})

/** Oldest first, so the chart reads left to right. */
const trend = computed(() =>
  attempts.value
    .slice(0, 40)
    .toReversed()
    .map((a) => ({ id: a.id, accuracy: a.accuracy ?? 0, tempo: a.tempoFactor })),
)

/** Per-bar totals over the last ten passes, so current weak spots stand out. */
const combined = computed<MeasureStats[]>(() => {
  const totals = new Map<number, BarTotals>()
  for (const a of attempts.value.slice(0, 10)) {
    for (const m of a.perMeasure) {
      const t = totals.get(m.measure) ?? { hit: 0, wrong: 0, miss: 0, devSum: 0, devCount: 0 }
      t.hit += m.hit
      t.wrong += m.wrong
      t.miss += m.miss
      if (m.meanDevMs !== null) {
        t.devSum += m.meanDevMs * m.hit
        t.devCount += m.hit
      }
      totals.set(m.measure, t)
    }
  }

  return Array.from(totals, ([measure, t]): MeasureStats => {
    const total = t.hit + t.wrong + t.miss
    return {
      measure,
      hit: t.hit,
      wrong: t.wrong,
      miss: t.miss,
      accuracy: total ? t.hit / total : null,
      meanDevMs: t.devCount ? t.devSum / t.devCount : null,
      stdDevMs: null,
    }
  }).toSorted((a, b) => a.measure - b.measure)
})

const shown = computed(() => focused.value?.perMeasure ?? combined.value)
const weakest = computed(() => worstMeasures(shown.value))

function handsLabel(a: Attempt) {
  const { L, R } = a.hands
  if (L === 'play' && R === 'play') return 'Both'
  if (L === 'play') return 'Left'
  if (R === 'play') return 'Right'
  return `${HAND_LABEL[L]} / ${HAND_LABEL[R]}`
}

function toggleFocus(id: number | undefined) {
  focus.value = id === undefined || id === focus.value ? null : id
}

watch(
  selected,
  async (hash) => {
    attempts.value = hash ? await repos.attempts.forPiece(hash) : []
    focus.value = null
  },
  { immediate: true },
)

onMounted(async () => {
  await library.ready
  const counts = await repos.attempts.countsByPiece()
  pieces.value = (await repos.pieces.all()).filter((p) => counts.has(p.hash))
  if (!selected.value && pieces.value[0]) selected.value = pieces.value[0].hash
})
</script>

<template>
  <main class="page">
    <div class="head">
      <h1>Stats</h1>
      <span class="spacer" />
      <label class="field">
        <span>Piece</span>
        <select v-model="selected">
          <option v-if="!pieces.length" value="">No passes yet</option>
          <option v-for="p in pieces" :key="p.hash" :value="p.hash">{{ p.title }}</option>
        </select>
      </label>
    </div>

    <template v-if="attempts.length">
      <div class="tiles">
        <div v-for="t in tiles" :key="t.label" class="card tile">
          <span class="muted">{{ t.label }}</span>
          <b class="num">{{ t.value }}</b>
          <span class="muted">{{ t.sub }}</span>
        </div>
      </div>

      <section class="card" aria-labelledby="trend-h">
        <div class="section-head">
          <h2 id="trend-h">Accuracy per pass</h2>
          <span class="muted"
            >Bar height is accuracy, the strip below is tempo. Click to inspect.</span
          >
        </div>
        <div class="chart">
          <div class="axis num"><span>100%</span><span>50%</span><span>0%</span></div>
          <div class="plot">
            <div class="bars">
              <button
                v-for="p in trend"
                :key="p.id"
                class="bar"
                :class="{ on: p.id === focus, clean: p.accuracy >= CLEAN }"
                :style="{ height: `${Math.max(2, p.accuracy * 100)}%` }"
                :aria-label="`${formatPercent(p.accuracy)} at ${Math.round(p.tempo * 100)}%`"
                :title="`${formatPercent(p.accuracy)} at ${Math.round(p.tempo * 100)}%`"
                @click="toggleFocus(p.id)"
              />
            </div>
            <div class="tempo">
              <span
                v-for="p in trend"
                :key="p.id"
                :style="{ height: `${Math.min(1, p.tempo / 1.5) * 100}%` }"
              />
            </div>
          </div>
        </div>
      </section>

      <section class="card" aria-labelledby="bars-h">
        <div class="section-head">
          <h2 id="bars-h">
            {{
              focused ? `Pass from ${dateFmt.format(focused.startedAt)}` : 'Bars, last 10 passes'
            }}
          </h2>
          <span class="spacer" />
          <div class="legend">
            <span><i style="background: var(--heat-good)" />95%+</span>
            <span><i style="background: var(--heat-ok)" />85–95</span>
            <span><i style="background: var(--heat-weak)" />75–85</span>
            <span><i style="background: var(--danger)" />under 75</span>
          </div>
        </div>
        <MeasureHeatmap :measures="shown" />
        <div class="row">
          <template v-if="weakest">
            <span class="muted">Weakest:</span>
            <span class="num"
              >bars {{ weakest.startMeasure + 1 }}–{{ weakest.endMeasure + 1 }}</span
            >
          </template>
          <span class="spacer" />
          <button v-if="focused" class="ghost" @click="focus = null">Show last 10 passes</button>
          <NuxtLink
            v-if="weakest"
            :to="`/practice/${selected}?loop=${weakest.startMeasure + 1}-${weakest.endMeasure + 1}`"
            class="btn primary"
            >Practice bars {{ weakest.startMeasure + 1 }}–{{ weakest.endMeasure + 1 }}</NuxtLink
          >
          <NuxtLink v-else :to="`/practice/${selected}`" class="btn primary">Practice</NuxtLink>
        </div>
      </section>

      <section aria-labelledby="recent-h" class="recent">
        <h2 id="recent-h">Passes</h2>
        <div class="table-box">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Bars</th>
                <th>Hands</th>
                <th>Tempo</th>
                <th>Accuracy</th>
                <th>Hit / wrong / missed</th>
                <th>Timing</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="a in attempts"
                :key="a.id"
                :class="{ focused: a.id === focus }"
                tabindex="0"
                @click="toggleFocus(a.id)"
                @keydown.enter="toggleFocus(a.id)"
              >
                <td class="muted">{{ dateFmt.format(a.startedAt) }}</td>
                <td class="num">
                  {{
                    a.startMeasure === undefined
                      ? 'all'
                      : `${a.startMeasure + 1}–${(a.endMeasure ?? a.startMeasure) + 1}`
                  }}
                </td>
                <td class="muted">{{ handsLabel(a) }}{{ a.mode === 'wait' ? ' · wait' : '' }}</td>
                <td class="num">{{ Math.round(a.tempoFactor * 100) }}%</td>
                <td class="num">
                  <span class="swatch" :style="{ background: heatColor(a.accuracy) }" />{{
                    formatPercent(a.accuracy)
                  }}
                </td>
                <td class="num muted">
                  {{ a.notes.hit }} / {{ a.notes.wrong }} / {{ a.notes.miss }}
                </td>
                <td class="num muted">{{ formatMs(a.meanDevMs) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
    <p v-else class="muted">Finish a pass in the practice view and it shows up here.</p>
  </main>
</template>

<style scoped>
.page {
  max-width: 1120px;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 16px;
}

h1 {
  font-size: 2rem;
  letter-spacing: -0.02em;
}

.head select {
  min-width: 260px;
  height: 40px;
}

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.tile {
  display: grid;
  gap: 4px;
  font-size: 0.78rem;
}

.tile b {
  font-size: 1.6rem;
  font-weight: 500;
}

.section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 12px;
  margin-bottom: 14px;
}

.section-head .muted {
  font-size: 0.8rem;
}

section.card {
  display: grid;
  gap: 4px;
}

section.card > .row {
  margin-top: 12px;
}

.chart {
  display: flex;
  gap: 10px;
}

.axis {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 160px;
  font-size: 0.7rem;
  color: var(--faint);
  text-align: right;
}

.plot {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 6px;
}

.bars {
  height: 160px;
  display: flex;
  align-items: flex-end;
  gap: 3px;
  border-bottom: 1px solid var(--border);
  background: linear-gradient(
    transparent calc(10% - 1px),
    var(--line) 10%,
    transparent calc(10% + 1px)
  );
}

.bar {
  flex: 1;
  min-width: 3px;
  max-width: 28px;
  padding: 0;
  border: 0;
  border-radius: 3px 3px 0 0;
  background: var(--surface-2);
}

.bar.clean {
  background: var(--faint);
}

.bar.on,
.bar:hover:not(:disabled) {
  background: var(--text);
}

.tempo {
  height: 16px;
  display: flex;
  align-items: flex-end;
  gap: 3px;
}

.tempo span {
  flex: 1;
  min-width: 3px;
  max-width: 28px;
  border-radius: 1px;
  background: var(--line);
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 0.75rem;
  color: var(--muted);
}

.legend span {
  display: flex;
  align-items: center;
  gap: 6px;
}

.legend i {
  width: 11px;
  height: 11px;
  border-radius: 3px;
}

.recent {
  display: grid;
  gap: 12px;
}

.table-box {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

table {
  min-width: 680px;
}

tbody tr {
  cursor: pointer;
}

tbody tr:last-child td {
  border-bottom: 0;
}

tbody tr:hover,
tr.focused {
  background: var(--surface);
}

.swatch {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 2px;
  margin-right: 8px;
}
</style>
