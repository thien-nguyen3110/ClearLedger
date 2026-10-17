import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 20000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:15173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tests/static-server.mjs',
    url: 'http://127.0.0.1:15173',
    reuseExistingServer: !process.env.CI,
    env: { PORT: '15173' },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
