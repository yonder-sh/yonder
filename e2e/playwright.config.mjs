// Playwright config for the Yonder e2e harness.
// Browsers come from nixpkgs (see pw.sh) — never run `playwright install` here.
import { defineConfig, devices } from '@playwright/test';

const FIXTURE_PORT = Number(process.env.E2E_FIXTURE_PORT ?? 4599); // avoid 631 6463 8081 9292
// Point at the real app later: E2E_BASE_URL=http://localhost:3000 ./pw.sh playwright test
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${FIXTURE_PORT}`;

export default defineConfig({
  testDir: './tests',
  // The app's specs have their own config (playwright.app.config.ts, `pnpm e2e`).
  testIgnore: ['app/**'],
  outputDir: './test-results',
  timeout: 30_000,
  fullyParallel: true,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  // Local static server for the fixture page; skipped when E2E_BASE_URL is set.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `nix shell nixpkgs#python3 -c python3 -m http.server ${FIXTURE_PORT} --bind 127.0.0.1 --directory fixtures`,
        url: `http://127.0.0.1:${FIXTURE_PORT}/`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
