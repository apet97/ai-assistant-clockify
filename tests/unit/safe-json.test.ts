import { describe, expect, it } from "vitest";
import { boundedSanitizedJson } from "../../src/harness/safe-json.js";

describe("bounded sanitized JSON", () => {
  it("bounds the final escaped JSON envelope for quotes, backslashes, and multibyte text", () => {
    const result = boundedSanitizedJson({
      value: `${"\\\"😀".repeat(10_000)}tail`,
      token: "SECRET",
    }, 4_096);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(4_096);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});
