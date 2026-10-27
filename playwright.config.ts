import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:3123',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  webServer: {
    command: 'pnpm nuxt dev --port 3123',
    url: 'http://localhost:3123',
    reuseExistingServer: true,
    timeout: 180_000,
  },
})
