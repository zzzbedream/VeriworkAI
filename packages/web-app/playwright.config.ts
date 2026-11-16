import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE_URL } from './e2e/support/env';

// `E2E_BROWSER_CHANNEL=msedge` (or `chrome`) runs the suite on an installed browser when Playwright's
// bundled Chromium is not available on the host. CI uses the bundled Chromium.
const channel = process.env.E2E_BROWSER_CHANNEL?.trim() || undefined;
const withChannel = channel === undefined ? {} : { channel };

export default defineConfig({
  testDir: './e2e',
  // Starts a throwaway database, builds the isolated E2E bundle and runs `next start` (see the file).
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 2 : 0,
  // CI also writes playwright-report/ (uploaded as an artifact when the job fails).
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: E2E_BASE_URL, trace: 'on-first-retry' },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], ...withChannel } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...withChannel } },
  ],
});
