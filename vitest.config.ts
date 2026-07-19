import { defineConfig } from "vitest/config";

// Separate from vite.config.ts on purpose: vite.config.ts sets `root: "src/ui"`
// for the UI bundle, which would misdirect Vitest's test discovery. Vitest uses
// this file when present and keeps the project root as the test root.
export default defineConfig({
  test: {
    root: ".",
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Keep the local and CI test resource ceiling deterministic on developer
    // machines with very high core counts. Individual concurrency tests use
    // explicit barriers rather than relying on a larger worker pool.
    maxWorkers: 4,
    retry: 0,
    ...(process.env.VITEST_RELEASE_REPORT_PATH
      ? {
          reporters: ["default", "json"],
          outputFile: { json: process.env.VITEST_RELEASE_REPORT_PATH },
        }
      : {}),
    // ONE RSA keypair for the whole suite (see tests/global-setup.ts) instead of
    // a per-file keygen that saturated the fork pool and flaked the gate (F1).
    globalSetup: ["./tests/global-setup.ts"],
  },
});
