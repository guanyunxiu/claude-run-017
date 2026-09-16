import { defineConfig, devices } from '@playwright/test';

/**
 * E2E configuration.
 *
 * Local run (against `docker compose up` or `npm run dev` stacks):
 *   E2E_BASE_URL=http://localhost:8080 npm test
 *
 * Inside docker compose the e2e service sets E2E_BASE_URL=http://frontend and
 * browsers are provided by the mcr.microsoft.com/playwright image.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8080';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputDir: 'playwright-report' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
