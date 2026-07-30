import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultChainCases,
  DRY_RUN_WORKSPACE_ID,
  LIVE_V2_PREFIX,
  readCleanupRegistryFile,
  reportContainsSecret,
  runLiveV2DryRun,
} from "../../scripts/live-v2-full.js";

/**
 * B3: the dry-run mode of `live:v2-full` proves the EXACT chain the live run
 * would execute — real v2 runner (scripted model), real SQLite store, real
 * OperationPreparationService and ConfirmationService behind the real routes —
 * against the FAKE Clockify host with a fetch guard installed, so no network
 * call is possible. Live mode swaps only the injected Clockify port and the
 * workspace identity; the chain code path is byte-identical.
 */

function scratchRegistryPath(): string {
  return join(mkdtempSync(join(tmpdir(), "live-v2-dry-run-")), "registry.json");
}

describe("B3: dry-run proves the preview→confirm chain against the fake host", () => {
  it("runs prepare-before-confirm with zero pre-confirm mutations, one-use nonces, and full cleanup", async () => {
    const registryPath = scratchRegistryPath();
    const { report, outcome } = await runLiveV2DryRun({ cleanupRegistryPath: registryPath });

    // The whole report passes: every case prepared, confirmed, cleaned.
    expect(report.status, JSON.stringify(report, null, 2)).toBe("passed");
    expect(report.mode).toBe("dry_run");
    expect(report.preparedWrites).toBeGreaterThanOrEqual(2);
    expect(report.confirmedWrites).toBe(report.preparedWrites);

    // ZERO external mutations before any confirm — the assertion the plan names.
    expect(report.preparationMutations).toBe(0);

    // The bypass is structurally absent; the report still pins the count.
    expect(report.trustedBypassCalls).toBe(0);

    // Every confirmed write's nonce was proven ONE-USE by an actual replay probe.
    expect(report.nonceReplayRejections).toBe(report.confirmedWrites);

    // Everything created was registered and removed — zero leftovers.
    expect(report.untrackedCreations).toBe(0);
    expect(report.resourcesCreated).toBeGreaterThanOrEqual(2);
    expect(report.leftovers).toBe(0);
    expect(report.leftoverKinds).toEqual([]);

    // The REPORT the driver exits on carries the per-case evidence: every
    // planned case present, judged, and named — a case-level failure or a
    // dropped case fails the emitted report itself, not only this test.
    expect(report.plannedWrites).toBe(outcome.plannedCases);
    expect(report.cases.map((reportCase) => reportCase.id))
      .toEqual(outcome.cases.map((chainCase) => chainCase.id));
    for (const reportCase of report.cases) {
      expect(reportCase.status).toBe("passed");
      expect(reportCase.failureCode).toBeUndefined();
    }

    for (const caseEvidence of outcome.cases) {
      // Chain ordering, per case: the operation is PREPARED and the run is
      // SUSPENDED before the confirmation; dispatch starts only after the
      // confirm; completion follows dispatch.
      const types = caseEvidence.eventTypes;
      const at = (type: string): number => types.indexOf(type);
      expect(at("operation.prepared"), types.join(",")).toBeGreaterThanOrEqual(0);
      expect(at("run.suspended")).toBeGreaterThan(at("operation.prepared"));
      expect(at("operation.confirmed")).toBeGreaterThan(at("run.suspended"));
      expect(at("operation.started")).toBeGreaterThan(at("operation.confirmed"));
      expect(at("operation.completed")).toBeGreaterThan(at("operation.started"));

      expect(caseEvidence.status).toBe("passed");
      expect(caseEvidence.prepared).toBe(true);
      expect(caseEvidence.confirmed).toBe(true);
      expect(caseEvidence.preConfirmMutations).toBe(0);
      // The replay probe RAN (only legal after the commit burned the nonce) and
      // was rejected.
      expect(caseEvidence.nonceReplayProbed).toBe(true);
      expect(caseEvidence.nonceReplayRejected).toBe(true);
      expect(caseEvidence.untrackedCreations).toBe(0);
      expect(caseEvidence.createdRefs.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("a case that never reaches a preview turns the EMITTED report red, named", async () => {
    // A read-only turn completes without suspending on a confirmation, so this
    // scripted case can never produce a prepared write. The report the driver
    // exits on — not merely test-side evidence — must fail and name the case.
    const registryPath = scratchRegistryPath();
    const cases = [
      ...defaultChainCases(`red${Date.now().toString(36)}`).filter((c) => c.id === "tag_create"),
      {
        id: "read_only_never_prepares",
        kind: "tag" as const,
        resourceName: `${LIVE_V2_PREFIX}NEVER_CREATED`,
        message: "List the projects in this workspace (sacrificial read-only case)",
        discoveryQuery: "list projects",
        actionName: "clockify_projects_list",
        arguments: {},
      },
    ];
    const { report, outcome } = await runLiveV2DryRun({ cleanupRegistryPath: registryPath, cases });

    expect(report.status).toBe("failed");
    expect(report.plannedWrites).toBe(2);
    const failed = report.cases.find((reportCase) => reportCase.id === "read_only_never_prepares");
    expect(failed?.status).toBe("failed");
    expect(failed?.failureCode).toBeDefined();
    // The healthy case still passed and was cleaned — the red status comes from
    // the per-case verdict and the prepared/confirmed disagreement alone.
    expect(report.cases.find((reportCase) => reportCase.id === "tag_create")?.status).toBe("passed");
    expect(report.leftovers).toBe(0);
    expect(outcome.confirmedWrites).toBeLessThan(outcome.plannedCases);
  });

  it("persists the cleanup registry to the provided path as entities are created", async () => {
    const registryPath = scratchRegistryPath();
    const { outcome } = await runLiveV2DryRun({ cleanupRegistryPath: registryPath });

    const file = readCleanupRegistryFile(registryPath);
    expect(file.kind).toBe("v2_live_cleanup_registry");
    expect(file.resources.length).toBeGreaterThanOrEqual(2);
    for (const resource of file.resources) {
      expect(resource.name.startsWith(LIVE_V2_PREFIX)).toBe(true);
      expect(resource.removed).toBe(true);
    }
    expect(outcome.removedIds.length).toBe(file.resources.length);
  });

  it("emits a secret-free report: no nonce, no created id, no raw workspace id", async () => {
    const registryPath = scratchRegistryPath();
    const { report, outcome } = await runLiveV2DryRun({ cleanupRegistryPath: registryPath });

    expect(outcome.collectedNonces.length).toBeGreaterThanOrEqual(2);
    const createdIds = outcome.cases.flatMap((c) => c.createdRefs.map((ref) => ref.id));
    expect(createdIds.length).toBeGreaterThanOrEqual(2);

    expect(reportContainsSecret(report, [
      ...outcome.collectedNonces,
      ...createdIds,
      DRY_RUN_WORKSPACE_ID,
    ])).toBe(false);
  });
});
