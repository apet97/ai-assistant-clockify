import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ACTION_CATALOG, actionFingerprint, catalogHash, getAction } from "../../src/harness/catalog.js";
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
        mutationWorkflow: action!.mutationWorkflow,
        mutationContract: action!.mutationContract,
        writeAuthority: action!.writeAuthority,
        preparedSafeWrite: !!action!.prepareSafeWrite && !!action!.executeSafeWrite,
      }))
      .digest("hex");

    expect(actionFingerprint(action!.name)).toBe(expected);
  });

  it("stably fingerprints every catalog action and the ordered catalog", () => {
    const contracts = ACTION_CATALOG.map((action) => ({
      name: action.name,
      args: summarizeArgs(action.schema),
      featureGroup: action.featureGroup,
      risks: action.risks,
      argumentAliases: action.argumentAliases ?? [],
      argumentOpenPaths: action.argumentOpenPaths ?? [],
      mutationWorkflow: action.mutationWorkflow,
      mutationContract: action.mutationContract,
      writeAuthority: action.writeAuthority,
      preparedSafeWrite: !!action.prepareSafeWrite && !!action.executeSafeWrite,
    }));

    for (const contract of contracts) {
      expect(actionFingerprint(contract.name)).toBe(
        createHash("sha256").update(JSON.stringify(contract)).digest("hex"),
      );
    }
    expect(catalogHash()).toBe(
      createHash("sha256").update(JSON.stringify(contracts)).digest("hex"),
    );
  });
});
