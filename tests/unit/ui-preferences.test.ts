import { describe, expect, it } from "vitest";

import { clockifyUiPreferences } from "../../src/ui-preferences.js";

describe("verified Clockify UI preferences", () => {
  it("preserves only supported theme/language and a valid IANA timezone", () => {
    expect(clockifyUiPreferences("DARK", "SR", "Europe/Belgrade")).toEqual({
      theme: "dark",
      language: "sr",
      timeZone: "Europe/Belgrade",
    });
    expect(clockifyUiPreferences("other", "xx", "not/a-zone")).toEqual({
      theme: "system",
      language: "en",
    });
  });
});
