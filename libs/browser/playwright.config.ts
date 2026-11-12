import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';

// The browser security specs are not in this repository: they are in the private submodule
// `security-tests` (see SECURITY-TESTS.md). Where it is checked out they run as a second project;
// elsewhere the run has the public specs only. scripts/security-tests.mjs runs that project alone.
const securitySpecs = path.resolve(__dirname, '../../security-tests/specs/browser');

export default defineConfig({
  testDir: path.resolve(__dirname, 'e2e'),
  testMatch: '**/*.spec.ts',
  globalSetup: path.resolve(__dirname, 'e2e/global-setup.ts'),
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  // The timeout specs measure real time; one retry absorbs a stalled CI runner, and Playwright
  // still reports the test as flaky.
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4400',
    headless: true,
    trace: process.env.CI ? 'retain-on-failure' : 'off',
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
    ...(existsSync(securitySpecs)
      ? [
          {
            name: 'chromium-security',
            testDir: securitySpecs,
            use: { browserName: 'chromium' as const },
          },
        ]
      : []),
  ],
});
