import { describe, expect, it } from "vitest";
import {
  buildLiveV2Report,
  checkLivePreconditions,
  LiveCleanupRegistry,
  LIVE_RESOURCE_ORDER,
  LIVE_V2_PREFIX,
  reportContainsSecret,
  SACRIFICIAL_MARKER,
} from "../../scripts/live-v2-full.js";

/**
 * T17-F: the guard, registry, cleanup ordering and report contract of the
 * sacrificial live harness — proven WITHOUT any Clockify call. No test here may
 * touch the network; the live driver itself needs separate T18-H authorization.
 */

const FULL = {
  liveOptIn: "1",
  sacrificialMarker: SACRIFICIAL_MARKER,
  apiKey: "live-key",
  workspaceId: "65b3aaaaaaaaaaaaaaaab60e",
  cleanupRegistryPath: "/tmp/registry.json",
};

describe("T17-F: the harness refuses to run without ALL FOUR preconditions", () => {
  it("accepts only the complete set", () => {
    const result = checkLivePreconditions(FULL);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected preconditions to pass");
    expect(result.workspaceId).toBe(FULL.workspaceId);
    expect(result.cleanupRegistryPath).toBe(FULL.cleanupRegistryPath);
  });

  it.each([
    ["live_opt_in_missing", { liveOptIn: undefined }],
    ["live_opt_in_missing", { liveOptIn: "true" }],
    ["sacrificial_marker_missing", { sacrificialMarker: undefined }],
    ["sacrificial_marker_missing", { sacrificialMarker: "production" }],
    ["credentials_missing", { apiKey: undefined }],
    ["workspace_missing", { workspaceId: undefined }],
    ["cleanup_registry_missing", { cleanupRegistryPath: undefined }],
  ])("refuses with %s", (failure, override) => {
    const result = checkLivePreconditions({ ...FULL, ...override });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.failures).toContain(failure);
  });

  it("reports EVERY missing precondition, not just the first", () => {
    const result = checkLivePreconditions({
      liveOptIn: undefined,
      sacrificialMarker: undefined,
      apiKey: undefined,
      workspaceId: undefined,
      cleanupRegistryPath: undefined,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.failures.sort()).toEqual([
      "cleanup_registry_missing",
      "credentials_missing",
      "live_opt_in_missing",
      "sacrificial_marker_missing",
      "workspace_missing",
    ]);
  });

  it("never accepts a workspace id as proof the workspace is disposable", () => {
    const result = checkLivePreconditions({ ...FULL, sacrificialMarker: FULL.workspaceId });
    expect(result.ok).toBe(false);
  });
});

describe("T17-F: the cleanup registry records only fixture-owned resources", () => {
  it("rejects a resource whose name lacks the fixture prefix", () => {
    const registry = new LiveCleanupRegistry();
    expect(() => registry.record({ kind: "project", id: "p1", name: "Real client project" }))
      .toThrow(/live_resource_not_fixture_owned:project/);
    expect(registry.size()).toBe(0);
  });

  it("accepts a prefixed resource", () => {
    const registry = new LiveCleanupRegistry();
    registry.record({ kind: "project", id: "p1", name: `${LIVE_V2_PREFIX}project` });
    expect(registry.size()).toBe(1);
  });

  it("cleans up in reverse dependency order: children before parents", () => {
    const registry = new LiveCleanupRegistry();
    registry.record({ kind: "client", id: "c1", name: `${LIVE_V2_PREFIX}client` });
    registry.record({ kind: "project", id: "p1", name: `${LIVE_V2_PREFIX}project`, parentId: "c1" });
    registry.record({ kind: "task", id: "t1", name: `${LIVE_V2_PREFIX}task`, parentId: "p1" });
    registry.record({ kind: "tag", id: "g1", name: `${LIVE_V2_PREFIX}tag` });

    const order = registry.cleanupOrder().map((resource) => resource.id);
    // tag and task are deepest, client is the parent and goes last.
    expect(order.indexOf("t1")).toBeLessThan(order.indexOf("p1"));
    expect(order.indexOf("p1")).toBeLessThan(order.indexOf("c1"));
    expect(order[order.length - 1]).toBe("c1");
  });

  it("reverses insertion order within one kind so the newest child dies first", () => {
    const registry = new LiveCleanupRegistry();
    registry.record({ kind: "tag", id: "g1", name: `${LIVE_V2_PREFIX}a` });
    registry.record({ kind: "tag", id: "g2", name: `${LIVE_V2_PREFIX}b` });
    expect(registry.cleanupOrder().map((r) => r.id)).toEqual(["g2", "g1"]);
  });

  it("pins the dependency order used for cleanup", () => {
    expect(LIVE_RESOURCE_ORDER).toEqual(["client", "project", "task", "tag"]);
  });
});

describe("T17-F: only a clean, confirmed, bypass-free run passes", () => {
  function registryWithOne(): LiveCleanupRegistry {
    const registry = new LiveCleanupRegistry();
    registry.record({ kind: "tag", id: "g1", name: `${LIVE_V2_PREFIX}tag` });
    return registry;
  }

  it("passes a prepared-then-confirmed run with zero leftovers", () => {
    const report = buildLiveV2Report({
      workspaceId: FULL.workspaceId,
      preparedWrites: 1,
      confirmedWrites: 1,
      registry: registryWithOne(),
      removedIds: ["g1"],
    });
    expect(report.status).toBe("passed");
    expect(report.leftovers).toBe(0);
    expect(report.resourcesCreated).toBe(1);
    expect(report.resourcesRemoved).toBe(1);
    expect(report.leftoverKinds).toEqual([]);
  });

  it("fails on ANY leftover and names its kind", () => {
    const report = buildLiveV2Report({
      workspaceId: FULL.workspaceId,
      preparedWrites: 1,
      confirmedWrites: 1,
      registry: registryWithOne(),
      removedIds: [],
    });
    expect(report.status).toBe("failed");
    expect(report.leftovers).toBe(1);
    expect(report.leftoverKinds).toEqual(["tag"]);
  });

  it("fails when preparation touched the host", () => {
    const report = buildLiveV2Report({
      preparedWrites: 1,
      confirmedWrites: 1,
      preparationMutations: 1,
      registry: registryWithOne(),
      removedIds: ["g1"],
    });
    expect(report.status).toBe("failed");
    expect(report.preparationMutations).toBe(1);
  });

  it("fails when the trusted immediate-write bypass was used instead of a confirmation", () => {
    const report = buildLiveV2Report({
      preparedWrites: 1,
      confirmedWrites: 1,
      trustedBypassCalls: 1,
      registry: registryWithOne(),
      removedIds: ["g1"],
    });
    expect(report.status).toBe("failed");
    expect(report.trustedBypassCalls).toBe(1);
  });

  it("fails a run that prepared nothing or confirmed nothing — an empty run is not a pass", () => {
    expect(buildLiveV2Report({ preparedWrites: 0, confirmedWrites: 0 }).status).toBe("failed");
    expect(buildLiveV2Report({ preparedWrites: 1, confirmedWrites: 0 }).status).toBe("failed");
  });

  it("reports refused with the exact missing preconditions and no resource claims", () => {
    const report = buildLiveV2Report({ preconditionFailures: ["live_opt_in_missing", "credentials_missing"] });
    expect(report.status).toBe("refused");
    expect(report.preconditionFailures).toEqual(["live_opt_in_missing", "credentials_missing"]);
    expect(report.resourcesCreated).toBe(0);
    expect(report.confirmedWrites).toBe(0);
  });

  it("never carries a credential or the raw workspace id", () => {
    const report = buildLiveV2Report({
      workspaceId: FULL.workspaceId,
      preparedWrites: 1,
      confirmedWrites: 1,
      registry: registryWithOne(),
      removedIds: ["g1"],
    });
    expect(reportContainsSecret(report, [FULL.apiKey, FULL.workspaceId])).toBe(false);
    // Only a bounded suffix survives, enough to correlate a run.
    expect(report.workspaceIdSuffix).toBe("b60e");
  });
});
