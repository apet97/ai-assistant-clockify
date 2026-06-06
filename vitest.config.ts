import { defineConfig } from "vitest/config";

// Separate from vite.config.ts on purpose: vite.config.ts sets `root: "src/ui"`
// for the UI bundle, which would misdirect Vitest's test discovery. Vitest uses
// this file when present and keeps the project root as the test root.
export default defineConfig({
  test: {
    root: ".",
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
