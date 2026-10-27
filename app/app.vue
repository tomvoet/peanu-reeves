<script setup lang="ts">
import type { ResolvedTheme } from '~/composables/useTheme'

const THEME_COLORS = {
  dark: '#000000',
  light: '#f2f0eb',
} as const satisfies Record<ResolvedTheme, string>

const audio = useAudioStatus()
const route = useRoute()
const theme = useTheme()

const immersive = computed(() => route.path.startsWith('/practice') || route.path === '/free')

watchEffect(() => (document.documentElement.dataset.theme = theme.value))
useHead({ meta: [{ name: 'theme-color', content: () => THEME_COLORS[theme.value] }] })
</script>

<template>
  <NuxtPwaManifest />
  <div class="shell" :class="{ immersive }">
    <header v-if="!immersive" class="nav">
      <NuxtLink to="/" class="brand">
        <img src="/favicon.svg" alt="" width="24" height="24" />
        Peanu Reeves
      </NuxtLink>
      <nav class="row">
        <NuxtLink to="/">Library</NuxtLink>
        <NuxtLink to="/stats">Stats</NuxtLink>
        <NuxtLink to="/settings">Settings</NuxtLink>
      </nav>
      <span class="spacer" />
      <AudioBadge :audio="audio" />
    </header>
    <NuxtPage />
    <footer v-if="!immersive" class="footer">
      <NuxtLink to="/privacy">Privacy</NuxtLink>
    </footer>
  </div>
</template>

<style scoped>
.nav {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 650;
  text-decoration: none;
}

nav a {
  color: var(--muted);
  text-decoration: none;
  padding: 8px 14px;
  border-radius: 8px;
  font-weight: 500;
}

nav a:hover {
  color: var(--text);
}

nav a.router-link-exact-active {
  color: var(--text);
  background: var(--surface-2);
}

.shell:not(.immersive) {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}

.shell:not(.immersive) > * {
  width: 100%;
}

.footer {
  margin-top: auto;
  padding: 0 20px 24px;
  text-align: center;
  font-size: 0.82rem;
}

.footer a {
  color: var(--muted);
}

@media (max-width: 640px) {
  .nav {
    flex-wrap: wrap;
    gap: 12px;
  }
}
</style>
