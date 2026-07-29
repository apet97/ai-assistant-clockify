import { defineConfig, devices } from "@playwright/test";

const port = 4175;

/**
 * Closure-plan PR 12 (F05): the REAL-server browser matrix. Unlike the fixture
 * config (playwright.config.ts — a renderer/contract suite over hand-authored
 * frames), this mode boots the tsc-built production composition
 * (tests/e2e-real/server/main.ts): real createApp, real temp SQLite, real
 * signed-JWT component auth, the built dist/ui bundle, scripted model + fake
 * Clockify at their production injection seams. Scenario switching mutates one
 * shared server, so the suite runs strictly serially.
 */
export default defineConfig({
  testDir: "tests/e2e-real",
  testIgnore: ["**/server/**"],
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: `https://127.0.0.1:${port}`,
    // The server boots with a throwaway self-signed cert (real HTTPS is
    // required by the Secure/Partitioned cookie and the /api/me link invariant).
    ignoreHTTPSErrors: true,
    actionTimeout: 5_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node dist-e2e/tests/e2e-real/server/main.js",
    url: `https://127.0.0.1:${port}/e2e/healthz`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { E2E_REAL_PORT: String(port) },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
