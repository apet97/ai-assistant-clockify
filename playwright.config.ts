import { defineConfig, devices } from "@playwright/test";

const port = 4174;

/**
 * RENDERER/CONTRACT suite (closure-plan PR 12 relabel): these specs run the
 * real built UI against `tests/e2e/fixtures/server.mjs`, a fixture that
 * hand-authors protocol frames. They pin the CLIENT's rendering, keyboard,
 * accessibility, and protocol-decoding contracts — they are NOT product
 * evidence that the server produces those frames. The PRODUCT browser matrix
 * is `playwright.real.config.ts` (`npm run test:e2e:real`): the tsc-built
 * production composition with a real SQLite store, real signed-JWT component
 * auth, and no hand-authored frames.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // A release pass must be the first execution, not a retry-masked success.
  // The suite uses explicit fixture synchronization for transient UI states.
  retries: 0,
  // Keep the cross-engine load deterministic too. Four concurrent Firefox
  // processes can spend most of the 20 s test budget in browser/context setup
  // on this supported development host; three completes the same journeys in
  // one pass without relaxing assertions or adding retries.
  workers: 3,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  timeout: 20_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    actionTimeout: 5_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node tests/e2e/fixtures/server.mjs",
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { E2E_PORT: String(port) },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
