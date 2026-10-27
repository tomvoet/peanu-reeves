<script setup lang="ts">
import type { MeasureStats } from '#engine/stats/aggregate'

const props = defineProps<{
  measures: MeasureStats[]
  selected?: { startMeasure: number; endMeasure: number } | null
}>()
const emit = defineEmits<{ select: [measure: number, extend: boolean] }>()

function isSelected(measure: number): boolean {
  const s = props.selected
  return !!s && measure >= s.startMeasure && measure <= s.endMeasure
}

function titleOf(m: MeasureStats): string {
  const spread = m.stdDevMs === null ? '–' : Math.round(m.stdDevMs)
  return (
    `Bar ${m.measure + 1}: ${formatPercent(m.accuracy)} · ` +
    `${m.hit} hit, ${m.wrong} wrong, ${m.miss} missed · ` +
    `timing ${formatMs(m.meanDevMs)} ± ${spread} ms`
  )
}
</script>

<template>
  <div class="heatmap" role="list">
    <button
      v-for="m in measures"
      :key="m.measure"
      role="listitem"
      class="cell"
      :class="{ selected: isSelected(m.measure) }"
      :style="{ background: heatColor(m.accuracy), color: heatInk(m.accuracy) }"
      :title="titleOf(m)"
      @click="emit('select', m.measure, $event.shiftKey)"
    >
      <span class="bar num">{{ m.measure + 1 }}</span>
      <span class="acc num">{{ formatPercent(m.accuracy) }}</span>
      <span class="dev num">{{ m.meanDevMs === null ? '' : formatMs(m.meanDevMs) }}</span>
    </button>
  </div>
</template>

<style scoped>
.heatmap {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(68px, 1fr));
  gap: 4px;
}

.cell {
  display: grid;
  gap: 1px;
  padding: 6px 7px;
  border-radius: 6px;
  border: 2px solid transparent;
  text-align: left;
  font-size: 0.78rem;
}

.cell.selected {
  border-color: var(--text);
  box-shadow: 0 0 0 2px var(--bg) inset;
}

.bar {
  opacity: 0.75;
  font-size: 0.7rem;
}

.acc {
  font-weight: 650;
  font-size: 0.9rem;
}

.dev {
  font-size: 0.68rem;
  opacity: 0.85;
  min-height: 1em;
}
</style>
