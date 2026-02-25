import { defineConfig } from '@playwright/test';
import path from 'node:path';

export default defineConfig({
  testDir: path.resolve(__dirname, 'e2e'),
  testMatch: '**/*.spec.ts',
  globalSetup: path.resolve(__dirname, 'e2e/global-setup.ts'),
  timeout: 60_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: 'http://localhost:4400',
    headless: true,
  },
  webServer: {
    command: 'npx serve -l 4400 --no-clipboard e2e/fixtures',
    cwd: __dirname,
    port: 4400,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
