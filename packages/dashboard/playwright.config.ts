import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against a real daemon (`node packages/daemon/dist/main.js --fake`, or
 * the same daemon started in-process with fake apps and a fake clock). Run `pnpm build`
 * first. Traces and screenshots go to qa-artifacts/ (git-ignored).
 */
export default defineConfig({
  testDir: 'e2e',
  outputDir: '../../qa-artifacts/m2-dashboard/test-results',
  timeout: 30_000,
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 420, height: 800 },
    trace: 'retain-on-failure',
  },
});
