import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'on-first-retry',
    video: process.env.RECORD_DEMO === '1'
      ? { mode: 'on', size: { width: 1440, height: 900 } }
      : 'off',
  },
  webServer: [{
    command: 'python3 tests/serve_backend.py',
    url: 'http://127.0.0.1:18000/api/health',
    reuseExistingServer: false,
    timeout: 30000,
  }, {
    command: 'npm run dev -- --host 127.0.0.1 --port 4174 --strictPort',
    env: { API_PROXY_TARGET: 'http://127.0.0.1:18000' },
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 30000,
  }],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
