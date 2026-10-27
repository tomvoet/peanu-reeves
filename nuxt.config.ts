const WINDOWS_DRIVE = /^\/([A-Za-z]:)/

export default defineNuxtConfig({
  compatibilityDate: '2026-10-26',
  ssr: false,
  devtools: { enabled: true },
  modules: ['@vueuse/nuxt', '@vite-pwa/nuxt'],
  css: [
    '@fontsource-variable/geist',
    '@fontsource-variable/geist-mono',
    '@fontsource/noto-music/music.css',
    '~/assets/main.css',
  ],
  alias: {
    '#engine': fileURLToPath(new URL('./engine', import.meta.url)),
    '#db': fileURLToPath(new URL('./db', import.meta.url)),
  },
  typescript: {
    strict: true,
    tsConfig: { include: ['../engine/**/*', '../db/**/*'] },
  },
  app: {
    head: {
      title: 'Peanu Reeves',
      meta: [{ name: 'theme-color', content: '#0b0c0e' }],
      link: [
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon-180x180.png' },
      ],
    },
  },
  pwa: {
    registerType: 'autoUpdate',
    manifest: {
      name: 'Peanu Reeves Piano Practice',
      short_name: 'Peanu Reeves',
      description: 'Practice piano pieces with a MIDI keyboard',
      theme_color: '#0b0c0e',
      background_color: '#0b0c0e',
      display: 'standalone',
      icons: [
        { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
        { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
        {
          src: 'maskable-icon-512x512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
      ],
    },
    workbox: {
      navigateFallback: '/',
      globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
      runtimeCaching: [
        {
          urlPattern: /\/samples\/[\w-]+\/[\w.-]+\.(?:json|ogg|m4a)$/,
          handler: 'CacheFirst',
          options: {
            cacheName: 'piano-samples',
            expiration: { maxEntries: 1000 },
            cacheableResponse: { statuses: [0, 200] },
          },
        },
      ],
    },
    client: { installPrompt: true },
    devOptions: { enabled: false },
  },
})

function fileURLToPath(url: URL) {
  return decodeURIComponent(url.pathname.replace(WINDOWS_DRIVE, '$1'))
}
