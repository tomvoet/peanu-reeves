<script setup lang="ts">
import { scheduleClick } from '#engine/audio/click'

const BPM = 90
const CLICKS = 16
const WARMUP = 4
const BEAT_SEC = 60 / BPM

const runtime = useRuntime()
const settings = useSettings()

const running = ref(false)
const beat = ref(-1)
/** Offset per click in ms, null for warm-up clicks and clicks nobody tapped. */
const taps = ref<(number | null)[]>([])
let clickTimes: number[] = []

const offsets = computed(() => taps.value.filter((t): t is number => t !== null))

const result = computed<{ median: number; spread: number } | null>(() => {
  if (offsets.value.length < 4) return null
  const sorted = offsets.value.toSorted((a, b) => a - b)
  const median = sorted[sorted.length >> 1]!
  const spread =
    sorted[Math.floor(sorted.length * 0.75)]! - sorted[Math.floor(sorted.length * 0.25)]!
  return { median: Math.round(median), spread: Math.round(spread) }
})

const bars = computed(() =>
  Array.from({ length: CLICKS }, (_, i) => {
    const v = taps.value[i] ?? null
    return {
      warm: i < WARMUP,
      now: beat.value === i,
      height: v === null ? 8 : 8 + Math.min(1, Math.abs(v) / 120) * 40,
      late: v !== null && v > 0,
      tapped: v !== null,
    }
  }),
)

const ticker = useIntervalFn(
  () => {
    const now = runtime.clock.now()
    beat.value = clickTimes.findLastIndex((t) => t <= now)
    if (now > clickTimes.at(-1)! + BEAT_SEC) stop()
  },
  30,
  { immediate: false },
)

function start() {
  void runtime.ctx.resume()
  taps.value = Array.from<number | null>({ length: CLICKS }).fill(null)

  const t0 = runtime.ctx.currentTime + 0.5
  clickTimes = Array.from({ length: CLICKS }, (_, i) => t0 + i * BEAT_SEC)
  clickTimes.forEach((t, i) => scheduleClick(runtime.ctx, t, i % 4 === 0))

  running.value = true
  ticker.resume()
}

function stop() {
  ticker.pause()
  running.value = false
  beat.value = -1
  if (result.value) settings.inputOffsetMs = result.value.median
}

function tap(t: number) {
  if (!running.value) return
  const nearest = clickTimes.reduce((best, c) => (Math.abs(c - t) < Math.abs(best - t) ? c : best))
  const i = clickTimes.indexOf(nearest)
  const offset = (t - nearest) * 1000
  if (i < WARMUP || Math.abs(offset) >= 300 || taps.value[i] !== null) return
  taps.value = taps.value.map((v, j) => (j === i ? offset : v))
}

const offNoteOn = runtime.input.onNoteOn((_p, _v, t) => tap(t))
onBeforeUnmount(offNoteOn)

onKeyStroke(' ', (e) => {
  if (!running.value) return
  e.preventDefault()
  if (!e.repeat) tap(runtime.clock.fromPerf(e.timeStamp))
})
</script>

<template>
  <div class="calibration">
    <div class="main">
      <div>
        <h3>Calibrate input delay</h3>
        <p class="muted">
          Tap any key on each click at {{ BPM }} bpm (Space works too). The first
          {{ WARMUP }} clicks are a warm-up. The median offset is subtracted from every note you
          play.
        </p>
      </div>
      <div class="clicks" aria-hidden="true">
        <span
          v-for="(b, i) in bars"
          :key="i"
          :class="{ warm: b.warm, now: b.now, tapped: b.tapped }"
          :style="{ height: `${b.height}px` }"
        />
      </div>
      <div class="row">
        <button class="primary" :disabled="running" @click="start">
          {{ running ? 'Listening…' : offsets.length ? 'Run again' : 'Start calibration' }}
        </button>
        <button
          :disabled="running || settings.inputOffsetMs === 0"
          @click="settings.inputOffsetMs = 0"
        >
          Reset to 0
        </button>
      </div>
    </div>
    <div class="result">
      <span class="muted">Input offset</span>
      <b class="num">{{ formatMs(settings.inputOffsetMs) }}</b>
      <span class="muted">
        <template v-if="result">
          From {{ offsets.length }} taps · spread {{ result.spread }} ms
        </template>
        <template v-else-if="running">{{ offsets.length }} taps so far</template>
        <template v-else>Applied to scoring only, never to sound</template>
      </span>
    </div>
  </div>
</template>

<style scoped>
.calibration {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
}

.main {
  flex: 1 1 300px;
  display: grid;
  gap: 14px;
}

h3 {
  font-size: 0.95rem;
  font-weight: 500;
}

p {
  margin: 4px 0 0;
  font-size: 0.85rem;
  line-height: 1.5;
}

.clicks {
  display: grid;
  grid-template-columns: repeat(16, minmax(0, 1fr));
  gap: 4px;
  align-items: end;
  height: 48px;
}

.clicks span {
  border-radius: 2px;
  background: var(--surface-2);
  transition: background 60ms;
}

.clicks span.warm {
  background: transparent;
  outline: 1px dashed var(--border);
  outline-offset: -1px;
}

.clicks span.tapped {
  background: var(--muted);
}

.clicks span.now {
  background: var(--text);
}

.result {
  flex: 0 1 220px;
  display: grid;
  align-content: center;
  gap: 4px;
  padding: 18px;
  border-radius: var(--radius);
  background: var(--bg);
  border: 1px solid var(--border);
  font-size: 0.8rem;
}

.result b {
  font-size: 2rem;
  font-weight: 500;
}
</style>
