<script setup lang="ts">
import type { Hand, HandMode } from '#engine/types'

const MODES = [
  { value: 'play', label: 'Play', title: 'You play this hand' },
  { value: 'auto', label: 'Auto', title: 'The app plays this hand' },
  { value: 'ghost', label: 'Ghost', title: 'Shown but silent' },
  { value: 'hidden', label: 'Hide', title: 'Not shown, not played' },
] as const satisfies readonly { value: HandMode; label: string; title: string }[]

const props = defineProps<{ hand: Hand }>()
const mode = defineModel<HandMode>({ required: true })

const handName = computed(() => (props.hand === 'L' ? 'Left' : 'Right'))
</script>

<template>
  <div class="row hand">
    <span class="label" :class="`hand-${hand}`">{{ handName }}</span>
    <div class="segmented" role="radiogroup" :aria-label="`${handName} hand`">
      <button
        v-for="m in MODES"
        :key="m.value"
        role="radio"
        :aria-checked="mode === m.value"
        :class="{ active: mode === m.value }"
        :title="m.title"
        @click="mode = m.value"
      >
        {{ m.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.hand {
  gap: 8px;
  flex-wrap: nowrap;
}

.label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  width: 64px;
  color: var(--text);
}

.label::before {
  content: '';
  width: 12px;
  height: 12px;
  background: var(--right);
  border-radius: 6px;
}

.hand-L::before {
  background: linear-gradient(90deg, var(--left) 36%, var(--left-stripe) 36% 64%, var(--left) 64%);
  border-radius: 2px;
}

.segmented {
  flex: 1;
}

.segmented button {
  flex: 1;
  min-height: 36px;
}
</style>
