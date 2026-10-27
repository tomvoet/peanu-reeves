<script setup lang="ts">
import type { AudioStatus } from '~/composables/useApp'

const props = defineProps<{ audio: AudioStatus }>()

const label = computed<string>(() => {
  const a = props.audio
  if (a.error) return 'Piano failed to load'
  if (!a.ready)
    return a.total ? `Loading piano ${Math.round((a.loaded / a.total) * 100)}%` : 'Loading piano…'
  if (a.state !== 'running') return 'Click anywhere to enable audio'
  return 'Piano ready'
})

const tone = computed<'ok' | 'wait' | 'error'>(() => {
  const a = props.audio
  if (a.error) return 'error'
  return a.ready && a.state === 'running' ? 'ok' : 'wait'
})
</script>

<template>
  <span class="badge" :class="tone" :title="audio.error ?? undefined">
    <span class="dot" />
    {{ label }}
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 0.82rem;
  color: var(--muted);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
}

.ok .dot {
  background: var(--text);
}

.error .dot {
  background: var(--danger);
}

.wait .dot {
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}
</style>
