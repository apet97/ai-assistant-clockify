import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { actionFingerprint, getAction } from "../../src/harness/catalog.js";
import { summarizeArgs } from "../../src/harness/arg-summary.js";

describe("action compatibility fingerprints", () => {
  it("binds aliases and explicitly open argument paths", () => {
    const action = getAction("assistant_update_permissions");
    expect(action).toBeDefined();
    const expected = createHash("sha256")
      .update(JSON.stringify({
        name: action!.name,
        args: summarizeArgs(action!.schema),
        featureGroup: action!.featureGroup,
        risks: action!.risks,
        argumentAliases: action!.argumentAliases ?? [],
        argumentOpenPaths: ["groups"],
      }))
      .digest("hex");

    expect(actionFingerprint(action!.name)).toBe(expected);
  });
});
