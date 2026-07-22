import { describe, expect, it } from "vitest";
import config from "../../vitest.config.js";

describe("full verification resource budget", () => {
  it("uses a bounded low-contention worker pool and timeout", () => {
    expect(config).toMatchObject({
      test: {
        maxWorkers: 2,
        testTimeout: 30_000,
      },
    });
  });
});
