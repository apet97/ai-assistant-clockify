import { describe, expect, it } from "vitest";

import { clockifyUiPreferences } from "../../src/ui-preferences.js";

describe("verified Clockify UI preferences", () => {
  it("ignores Clockify language while preserving theme and a valid IANA timezone", () => {
    expect(clockifyUiPreferences("DARK", "Europe/Belgrade")).toEqual({
      theme: "dark",
      timeZone: "Europe/Belgrade",
    });
    expect(clockifyUiPreferences("other", "not/a-zone")).toEqual({
      theme: "system",
    });
  });
});
