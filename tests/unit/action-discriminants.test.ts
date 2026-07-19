import { describe, expect, it } from "vitest";
import { ACTION_CATALOG } from "../../src/harness/catalog.js";
import type { ActionDefinition } from "../../src/harness/action.js";

function assertExecutableContract(action: ActionDefinition): void {
  switch (action.kind) {
    case "read":
      expect(action.handler).toEqual(expect.any(Function));
      expect(action.prepareSafeWrite).toBeUndefined();
      expect(action.commit).toBeUndefined();
      return;
    case "safe_write":
      expect(action.prepareSafeWrite).toEqual(expect.any(Function));
      expect(action.executeSafeWrite).toEqual(expect.any(Function));
      expect(action.handler).toBeUndefined();
      expect(action.commit).toBeUndefined();
      return;
    case "risky_write":
      expect(action.handler).toEqual(expect.any(Function));
      expect(action.commit).toEqual(expect.any(Function));
      expect(action.prepareSafeWrite).toBeUndefined();
      return;
  }
}

describe("discriminated action contracts", () => {
  it("classifies every catalog entry into exactly one executable path", () => {
    for (const action of ACTION_CATALOG) assertExecutableContract(action);

    expect(ACTION_CATALOG.filter((action) => action.kind === "read").length).toBeGreaterThan(0);
    expect(ACTION_CATALOG.filter((action) => action.kind === "safe_write").length).toBeGreaterThan(0);
    expect(ACTION_CATALOG.filter((action) => action.kind === "risky_write").length).toBeGreaterThan(0);
  });
});
