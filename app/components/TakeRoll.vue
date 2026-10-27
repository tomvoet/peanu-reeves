<script setup lang="ts">
import type { TakeNote } from '#engine/recording/take'
import type { SongNote } from '#engine/types'

const props = withDefaults(
  defineProps<{
    /** What was played. */
    played: readonly TakeNote[]
    /** Score notes to outline behind it. Empty for a take without a piece. */
    score?: readonly SongNote[]
    from: number
    to: number
    height?: number
  }>(),
  { score: () => [], height: 96 },
)

const W = 1000

const view = computed(() => {
  const span = Math.max(0.1, props.to - props.from)
  const inRange = <T extends { pitch: number }>(list: readonly T[], start: (n: T) => number) =>
    list.filter((n) => start(n) >= props.from - 0.05 && start(n) <= props.to)

  const played = inRange(props.played, (n) => n.start)
  const score = inRange(props.score, (n) => n.startSec)
  const pitches = [...played.map((n) => n.pitch), ...score.map((n) => n.pitch)]
  if (!pitches.length) return null

  const lo = Math.min(...pitches) - 1
  const hi = Math.max(...pitches) + 1
  const h = props.height - 4
  const row = h / (hi - lo)
  const x = (t: number) => ((t - props.from) / span) * W
  const y = (p: number) => ((hi - p) / (hi - lo)) * h

  return {
    score: score.map((n) => ({
      x: x(n.startSec),
      w: Math.max(3, x(n.endSec) - x(n.startSec)),
      y: y(n.pitch) - row / 2,
      h: Math.max(3, row),
      hand: n.hand,
    })),
    played: played.map((n) => ({
      x: x(n.start),
      w: Math.max(3, x(n.end) - x(n.start)),
      y: y(n.pitch) - row / 3,
      h: Math.max(2, (row * 2) / 3),
      opacity: 0.45 + 0.55 * Math.min(1, n.velocity / 110),
    })),
  }
})
</script>

<template>
  <svg
    class="roll"
    :viewBox="`0 0 ${W} ${height}`"
    preserveAspectRatio="none"
    :style="{ height: `${height}px` }"
    aria-hidden="true"
  >
    <template v-if="view">
      <rect
        v-for="(n, i) in view.score"
        :key="`s${i}`"
        :x="n.x"
        :y="n.y"
        :width="n.w"
        :height="n.h"
        :class="['outline', n.hand]"
        rx="2"
      />
      <rect
        v-for="(n, i) in view.played"
        :key="`p${i}`"
        :x="n.x"
        :y="n.y"
        :width="n.w"
        :height="n.h"
        :opacity="n.opacity"
        class="played"
        rx="2"
      />
    </template>
  </svg>
</template>

<style scoped>
.roll {
  display: block;
  width: 100%;
}

.outline {
  fill: none;
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}

.outline.L {
  stroke: var(--left);
}

.outline.R {
  stroke: var(--right);
}

.played {
  fill: var(--text);
}
</style>
