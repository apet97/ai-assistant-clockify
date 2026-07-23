import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ACTION_CATALOG, actionFingerprint, catalogHash, getAction } from "../../src/harness/catalog.js";
import { summarizeArgs } from "../../src/harness/arg-summary.js";
import { PRESENTATION_RULES_VERSION } from "../../src/harness/prepared-write-presentation.js";

const contractFor = (action: (typeof ACTION_CATALOG)[number]) => {
  const hasApiMetadata = action.apiExposure !== undefined
    || action.apiExposureReason !== undefined
    || action.apiOperation !== undefined
    || action.adapterEndpoints !== undefined
    || action.availabilityByAuthClass !== undefined
    || action.boundedArgumentDictionaries !== undefined
    || action.materialFields !== undefined
    || action.normalizedOperationMaterialContract !== undefined
    || action.presentation !== undefined;
  return {
    name: action.name,
    args: summarizeArgs(action.schema),
    featureGroup: action.featureGroup,
    risks: action.risks,
    argumentAliases: action.argumentAliases ?? [],
    argumentOpenPaths: action.argumentOpenPaths ?? [],
    semanticLiteralAliases: action.semanticLiteralAliases ?? [],
    mutationWorkflow: action.mutationWorkflow,
    mutationContract: action.mutationContract,
    writeAuthority: action.writeAuthority,
    preparedSafeWrite: !!action.prepareSafeWrite && !!action.executeSafeWrite,
    ...(hasApiMetadata
      ? {
          apiExposure: action.apiExposure ?? null,
          apiExposureReason: action.apiExposureReason ?? null,
          apiOperation: action.apiOperation ?? null,
          adapterEndpoints: action.adapterEndpoints ?? null,
          availabilityByAuthClass: action.availabilityByAuthClass ?? null,
          boundedArgumentDictionaries: action.boundedArgumentDictionaries ?? [],
          materialFields: action.materialFields ?? [],
          normalizedOperationMaterialContract:
            action.normalizedOperationMaterialContract ?? [],
          presentation: action.presentation ?? null,
          presentationRulesVersion: PRESENTATION_RULES_VERSION,
        }
      : {}),
  };
};

describe("action compatibility fingerprints", () => {
  it("gives every model-visible write, including local permission changes, raw argument authority", () => {
    const missing = ACTION_CATALOG
      .filter((action) => action.kind !== "read" && !action.writeAuthority)
      .map((action) => action.name);
    expect(missing).toEqual([]);
    expect(getAction("assistant_update_permissions")?.writeAuthority).toMatchObject({
      literalControlledPaths: expect.arrayContaining(["groups.*"]),
      cardinality: { mode: "single", maxExecutions: 1 },
      mutationPlans: [],
    });
  });

  it("binds aliases and explicitly open argument paths", () => {
    const action = getAction("assistant_update_permissions");
    if (!action) throw new Error("assistant_update_permissions fixture missing");
    const expected = createHash("sha256")
      .update(JSON.stringify({ ...contractFor(action), argumentOpenPaths: ["groups"] }))
      .digest("hex");

    expect(actionFingerprint(action.name)).toBe(expected);
  });

  it("stably fingerprints every catalog action and the ordered catalog", () => {
    const contracts = ACTION_CATALOG.map(contractFor);

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
