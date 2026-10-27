<script setup lang="ts">
import type { MeasureStats } from '#engine/stats/aggregate'
import type { Measure } from '#engine/types'

interface Range {
  startMeasure: number
  endMeasure: number
}

type Gesture = 'pending' | 'scrub' | 'select' | 'resize-start' | 'resize-end'

const EDGE_PX = 7
const LABEL_STEPS = [1, 2, 4, 8, 16, 32, 64] as const

const props = withDefaults(
  defineProps<{
    measures: Measure[]
    duration: number
    time: number
    loop?: Range | null
    heat?: MeasureStats[] | null
    /** `hairline`: 2px strip for playing in focus mode. `ruler`: numbered, for paused or focus off. */
    variant?: 'hairline' | 'ruler'
  }>(),
  { variant: 'ruler' },
)
const emit = defineEmits<{
  seek: [sec: number]
  loop: [range: Range]
  clearLoop: [seekTo?: number]
}>()

const track = useTemplateRef<HTMLElement>('track')
const { width } = useElementSize(track)

/** Range being dragged out, shown instead of the current loop until released. */
const draft = ref<Range | null>(null)
const hover = ref<Gesture | null>(null)
let gesture: Gesture | null = null
let anchor = 0
let downX = 0

const pct = (sec: number): string =>
  `${(Math.min(Math.max(sec / props.duration, 0), 1) * 100).toFixed(3)}%`

const heatByMeasure = computed(() => new Map(props.heat?.map((m) => [m.measure, m.accuracy])))

const cells = computed(() =>
  props.measures.map((m) => ({
    index: m.index,
    grow: m.endSec - m.startSec,
    played: m.startSec < props.time,
    heat: heatByMeasure.value.get(m.index) ?? null,
  })),
)

const labels = computed(() => {
  const n = props.measures.length
  const every = LABEL_STEPS.find((s) => (width.value / n) * s >= 44) ?? 128
  return props.measures
    .filter((m) => m.index % every === 0)
    .map((m) => ({ n: m.index + 1, left: pct(m.startSec) }))
})

const shownLoop = computed(() => draft.value ?? props.loop ?? null)

const loopBox = computed(() => {
  const l = shownLoop.value
  const a = l && props.measures[l.startMeasure]
  const b = l && props.measures[l.endMeasure]
  if (!a || !b) return null
  return {
    left: pct(a.startSec),
    width: `${(((b.endSec - a.startSec) / props.duration) * 100).toFixed(3)}%`,
    label:
      l.startMeasure === l.endMeasure
        ? `Loop bar ${a.index + 1}`
        : `Loop bars ${a.index + 1}–${b.index + 1}`,
  }
})

const cursor = computed(() =>
  hover.value === 'resize-start' || hover.value === 'resize-end' || hover.value === 'scrub'
    ? 'ew-resize'
    : 'crosshair',
)

const isTrouble = (acc: number | null): boolean => acc !== null && acc < 0.85
const inLoop = (index: number): boolean =>
  !!shownLoop.value && index >= shownLoop.value.startMeasure && index <= shownLoop.value.endMeasure

function xToSec(clientX: number): number {
  const r = track.value!.getBoundingClientRect()
  return (Math.min(Math.max(clientX - r.left, 0), r.width) / r.width) * props.duration
}

function secToX(sec: number): number {
  const r = track.value!.getBoundingClientRect()
  return r.left + (sec / props.duration) * r.width
}

function measureAt(sec: number): number {
  const i = props.measures.findIndex((m) => sec < m.endSec)
  return i < 0 ? props.measures.length - 1 : i
}

function hitTest(clientX: number): Gesture {
  if (Math.abs(clientX - secToX(props.time)) <= EDGE_PX) return 'scrub'
  const l = props.loop
  const a = l && props.measures[l.startMeasure]
  const b = l && props.measures[l.endMeasure]
  if (a && b) {
    if (Math.abs(clientX - secToX(a.startSec)) <= EDGE_PX) return 'resize-start'
    if (Math.abs(clientX - secToX(b.endSec)) <= EDGE_PX) return 'resize-end'
  }
  return 'pending'
}

function down(e: PointerEvent) {
  if (e.button !== 0) return
  // Stops text selection and native drag, which would cancel the pointer stream.
  e.preventDefault()
  track.value!.focus()
  track.value!.setPointerCapture(e.pointerId)

  downX = e.clientX
  gesture = hitTest(e.clientX)
  const l = props.loop
  if (gesture === 'resize-start' && l) anchor = l.endMeasure
  else if (gesture === 'resize-end' && l) anchor = l.startMeasure
  else anchor = measureAt(xToSec(e.clientX))

  if (gesture === 'scrub') emit('seek', xToSec(e.clientX))
  else if (gesture !== 'pending') draft.value = { ...l! }
}

function move(e: PointerEvent) {
  if (!gesture) {
    hover.value = hitTest(e.clientX)
    return
  }
  if (gesture === 'scrub') return emit('seek', xToSec(e.clientX))
  if (gesture === 'pending') {
    if (Math.abs(e.clientX - downX) < 6) return
    gesture = 'select'
  }
  const m = measureAt(xToSec(e.clientX))
  draft.value = { startMeasure: Math.min(anchor, m), endMeasure: Math.max(anchor, m) }
}

function up(e: PointerEvent) {
  if (gesture === 'pending') {
    const sec = xToSec(e.clientX)
    const l = props.loop
    const inside =
      l &&
      sec >= props.measures[l.startMeasure]!.startSec &&
      sec < props.measures[l.endMeasure]!.endSec
    if (l && !inside) emit('clearLoop', sec)
    else emit('seek', sec)
  } else if (draft.value && gesture !== 'scrub') emit('loop', draft.value)
  gesture = null
  draft.value = null
}

function cancel() {
  gesture = null
  draft.value = null
}
</script>

<template>
  <div class="transport" :class="variant">
    <div v-if="variant === 'ruler'" class="labels num" aria-hidden="true">
      <span
        v-for="l in labels"
        :key="l.n"
        :class="{ edge: loop && (l.n === loop.startMeasure + 1 || l.n === loop.endMeasure + 1) }"
        :style="{ left: l.left }"
        >{{ l.n }}</span
      >
    </div>
    <div
      ref="track"
      class="track"
      role="slider"
      tabindex="0"
      aria-label="Position"
      title="Click to jump · drag across bars to loop them · click outside the loop to stop looping"
      :aria-valuemin="0"
      :aria-valuemax="Math.round(duration)"
      :aria-valuenow="Math.round(time)"
      :aria-valuetext="formatDuration(time)"
      :style="{ cursor }"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="cancel"
      @pointerleave="hover = null"
    >
      <div class="cells">
        <div
          v-for="c in cells"
          :key="c.index"
          class="cell"
          :class="{ played: c.played, looped: inLoop(c.index) }"
          :style="{ flexGrow: c.grow }"
        >
          <span v-if="isTrouble(c.heat)" class="trouble" />
        </div>
      </div>
      <div
        v-if="loopBox"
        class="loop"
        :class="{ draft: !!draft }"
        :style="{ left: loopBox.left, width: loopBox.width }"
      />
      <div class="head" :style="{ left: pct(time) }" />
    </div>
  </div>
</template>

<style scoped>
.transport {
  position: relative;
  width: 100%;
  user-select: none;
}

.track {
  position: relative;
  touch-action: none;
}

.ruler .track {
  height: 28px;
}

.hairline .track {
  height: 12px;
}

.track:focus-visible {
  outline: 2px solid var(--text);
  outline-offset: 4px;
}

.cells {
  position: absolute;
  inset: 0;
  display: flex;
  gap: 3px;
}

.hairline .cells {
  gap: 2px;
}

.cell {
  flex-basis: 0;
  min-width: 1px;
  position: relative;
}

.cell::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 8px;
  height: 10px;
  border-radius: 2px;
  background: rgb(var(--ink) / 0.14);
}

.hairline .cell::before {
  top: 0;
  height: 2px;
  border-radius: 0;
  background: rgb(var(--ink) / 0.12);
}

.cell.looped::before {
  background: rgb(var(--ink) / 0.32);
}

.cell.played::before {
  background: rgb(var(--ink) / 0.5);
}

.cell.played.looped::before {
  background: rgb(var(--ink) / 0.9);
}

.trouble {
  position: absolute;
  left: 50%;
  top: 22px;
  width: 6px;
  height: 6px;
  margin-left: -3px;
  border-radius: 50%;
  background: var(--danger);
}

.hairline .trouble {
  top: 5px;
  width: 4px;
  height: 4px;
  margin-left: -2px;
}

.loop {
  position: absolute;
  top: 3px;
  height: 20px;
  border: 1.5px solid rgb(var(--ink) / 0.85);
  border-radius: 5px;
  pointer-events: none;
}

.hairline .loop {
  display: none;
}

.loop.draft {
  border-style: dashed;
  background: rgb(var(--ink) / 0.08);
}

.head {
  position: absolute;
  top: 1px;
  height: 24px;
  width: 2px;
  margin-left: -1px;
  background: var(--hi);
  pointer-events: none;
}

.hairline .head {
  top: -2px;
  height: 6px;
}

.labels {
  position: relative;
  height: 24px;
  font-size: 18px;
  color: var(--faint);
}

.labels span {
  position: absolute;
  top: 0;
  white-space: nowrap;
}

.labels .edge {
  color: var(--hi);
}
</style>
