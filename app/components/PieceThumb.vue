<script setup lang="ts">
import type { PieceThumb } from '#db/schema'

const props = defineProps<{
  thumb?: PieceThumb
  /** Bar indexes to underline as weak. */
  weak?: number[]
  loop?: { startMeasure: number; endMeasure: number } | null
  dim?: boolean
  height?: number
}>()

const W = 1000
const H = computed(() => props.height ?? 52)

const view = computed(() => {
  const t = props.thumb
  if (!t || !t.notes.length) return null

  const pitches = t.notes.map((n) => n[2])
  const lo = Math.min(...pitches) - 1
  const hi = Math.max(...pitches) + 1
  const h = H.value - 8
  const x = (sec: number) => (sec / t.durationSec) * W
  const barX = (i: number) => x(t.barStarts[i] ?? t.durationSec)

  return {
    notes: t.notes.map(([start, dur, pitch, hand]) => ({
      x: x(start),
      w: Math.max(3, x(dur) - 1),
      y: ((hi - pitch) / (hi - lo)) * h,
      h: Math.max(2, h / (hi - lo)),
      hand,
    })),
    weak: (props.weak ?? []).map((i) => ({
      x: barX(i),
      w: Math.max(4, barX(i + 1) - barX(i) - 2),
    })),
    loop: props.loop
      ? {
          x: barX(props.loop.startMeasure),
          w: barX(props.loop.endMeasure + 1) - barX(props.loop.startMeasure),
        }
      : null,
    base: H.value - 3,
  }
})
</script>

<template>
  <svg
    class="thumb"
    :class="{ dim }"
    :viewBox="`0 0 ${W} ${H}`"
    preserveAspectRatio="none"
    :style="{ height: `${H}px` }"
    aria-hidden="true"
  >
    <template v-if="view">
      <rect
        v-if="view.loop"
        :x="view.loop.x"
        y="0"
        :width="view.loop.w"
        :height="H - 6"
        class="loop"
        rx="4"
      />
      <rect
        v-for="(n, i) in view.notes"
        :key="i"
        :x="n.x"
        :y="n.y"
        :width="n.w"
        :height="n.h"
        :class="n.hand ? 'r' : 'l'"
        :rx="n.hand ? Math.min(3, n.h / 2) : 0"
      />
      <line :x1="0" :x2="W" :y1="view.base" :y2="view.base" class="baseline" />
      <rect
        v-for="(b, i) in view.weak"
        :key="`w${i}`"
        :x="b.x"
        :y="view.base - 1"
        :width="b.w"
        height="3"
        class="weak"
      />
    </template>
  </svg>
</template>

<style scoped>
.thumb {
  display: block;
  width: 100%;
}

.r {
  fill: var(--text);
  opacity: 0.4;
}

.l {
  fill: var(--text);
  opacity: 0.2;
}

.dim .r,
.dim .l {
  opacity: 0.12;
}

.baseline {
  stroke: var(--line);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}

.weak {
  fill: var(--danger);
}

.loop {
  fill: none;
  stroke: rgb(var(--ink) / 0.35);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}
</style>
