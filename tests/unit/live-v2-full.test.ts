import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLiveV2Report,
  checkLivePreconditions,
  confirmPreparedCase,
  decideLiveV2Execution,
  LiveCleanupRegistry,
  LIVE_RESOURCE_ORDER,
  LIVE_V2_PREFIX,
  LIVE_V2_WRITE_AUTHORIZATION_VALUE,
  LIVE_V2_WRITE_AUTHORIZATION_VARIABLE,
  PersistedCleanupRegistry,
  pendingCleanupFromFile,
  readCleanupRegistryFile,
  reportContainsSecret,
  SACRIFICIAL_MARKER,
} from "../../scripts/live-v2-full.js";

/**
 * B3: the guard, the separate live-write authorization, the persisted cleanup
 * registry, and the report contract of the sacrificial live driver — proven
 * WITHOUT any Clockify call. No test here may touch the network; the dry-run
 * chain itself is proven against the fake host in
 * tests/integration/live-v2-full-dry-run.test.ts.
 */

const FULL = {
  liveOptIn: "1",
  sacrificialMarker: SACRIFICIAL_MARKER,
  apiKey: "live-key",
  workspaceId: "65b3aaaaaaaaaaaaaaaab60e",
  cleanupRegistryPath: "/tmp/registry.json",
};

const FULL_ENV: Record<string, string | undefined> = {
  LIVE_CLOCKIFY: "1",
  LIVE_SACRIFICIAL_WORKSPACE_MARKER: SACRIFICIAL_MARKER,
  LIVE_CLOCKIFY_API_KEY: FULL.apiKey,
  LIVE_WORKSPACE_ID: FULL.workspaceId,
  LIVE_V2_CLEANUP_REGISTRY_PATH: FULL.cleanupRegistryPath,
};

function scratchRegistryPath(): string {
  return join(mkdtempSync(join(tmpdir(), "live-v2-registry-")), "registry.json");
}

describe("B3: the driver refuses to run without ALL FIVE preconditions", () => {
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

describe("B3: live execution needs the separate per-step write authorization", () => {
  it("pins the documented authorization variable and its exact literal", () => {
    expect(LIVE_V2_WRITE_AUTHORIZATION_VARIABLE).toBe("LIVE_V2_WRITE_AUTHORIZATION");
    expect(LIVE_V2_WRITE_AUTHORIZATION_VALUE).toBe("execute-sacrificial-v2-writes");
  });

  it("refuses (not merely declines) when any precondition is missing", () => {
    const decision = decideLiveV2Execution({});
    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") throw new Error("expected a refusal");
    expect(decision.failures).toHaveLength(5);
  });

  it("with all five preconditions but NO authorization it is not_executed — never execute", () => {
    const decision = decideLiveV2Execution(FULL_ENV);
    expect(decision.kind).toBe("not_executed");
    if (decision.kind !== "not_executed") throw new Error("expected not_executed");
    expect(decision.reason).toBe("live_write_authorization_missing");
  });

  it.each(["1", "true", "yes", "EXECUTE-SACRIFICIAL-V2-WRITES"])(
    "a lookalike authorization value (%s) never executes",
    (value) => {
      const decision = decideLiveV2Execution({
        ...FULL_ENV,
        [LIVE_V2_WRITE_AUTHORIZATION_VARIABLE]: value,
      });
      expect(decision.kind).toBe("not_executed");
    },
  );

  it("executes only with the exact documented literal, carrying the fifth precondition", () => {
    const decision = decideLiveV2Execution({
      ...FULL_ENV,
      [LIVE_V2_WRITE_AUTHORIZATION_VARIABLE]: LIVE_V2_WRITE_AUTHORIZATION_VALUE,
    });
    expect(decision.kind).toBe("execute");
    if (decision.kind !== "execute") throw new Error("expected execute");
    expect(decision.workspaceId).toBe(FULL.workspaceId);
    expect(decision.apiKey).toBe(FULL.apiKey);
    expect(decision.cleanupRegistryPath).toBe(FULL.cleanupRegistryPath);
  });

  it("authorization without preconditions still refuses", () => {
    const decision = decideLiveV2Execution({
      [LIVE_V2_WRITE_AUTHORIZATION_VARIABLE]: LIVE_V2_WRITE_AUTHORIZATION_VALUE,
    });
    expect(decision.kind).toBe("refused");
  });
});

describe("B3: the cleanup registry records only fixture-owned resources", () => {
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

describe("B3: the cleanup registry is PERSISTED as entities are created", () => {
  it("proves the path is writable before any resource exists", () => {
    const path = scratchRegistryPath();
    new PersistedCleanupRegistry(path);
    expect(existsSync(path)).toBe(true);
    const file = readCleanupRegistryFile(path);
    expect(file.kind).toBe("v2_live_cleanup_registry");
    expect(file.resources).toEqual([]);
  });

  it("persists each created resource IMMEDIATELY, so an interrupted run is cleanable", () => {
    const path = scratchRegistryPath();
    const registry = new PersistedCleanupRegistry(path);

    registry.record({ kind: "project", id: "p1", name: `${LIVE_V2_PREFIX}project` });
    let file = readCleanupRegistryFile(path);
    expect(file.resources).toHaveLength(1);
    expect(file.resources[0]).toMatchObject({ kind: "project", id: "p1", removed: false });

    registry.record({ kind: "task", id: "t1", name: `${LIVE_V2_PREFIX}task`, parentId: "p1" });
    file = readCleanupRegistryFile(path);
    expect(file.resources).toHaveLength(2);
    expect(file.resources[1]).toMatchObject({ kind: "task", id: "t1", parentId: "p1", removed: false });
  });

  it("persists removals, and pendingCleanup excludes removed resources", () => {
    const path = scratchRegistryPath();
    const registry = new PersistedCleanupRegistry(path);
    registry.record({ kind: "project", id: "p1", name: `${LIVE_V2_PREFIX}project` });
    registry.record({ kind: "task", id: "t1", name: `${LIVE_V2_PREFIX}task`, parentId: "p1" });

    registry.markRemoved("t1");
    const file = readCleanupRegistryFile(path);
    expect(file.resources.find((r) => r.id === "t1")?.removed).toBe(true);
    expect(file.resources.find((r) => r.id === "p1")?.removed).toBe(false);
    expect(registry.pendingCleanup().map((r) => r.id)).toEqual(["p1"]);
  });

  it("a later process can recover the REVERSE-dependency cleanup order from the file alone", () => {
    const path = scratchRegistryPath();
    const registry = new PersistedCleanupRegistry(path);
    registry.record({ kind: "client", id: "c1", name: `${LIVE_V2_PREFIX}client` });
    registry.record({ kind: "project", id: "p1", name: `${LIVE_V2_PREFIX}project`, parentId: "c1" });
    registry.record({ kind: "task", id: "t1", name: `${LIVE_V2_PREFIX}task`, parentId: "p1" });

    const pending = pendingCleanupFromFile(readCleanupRegistryFile(path));
    expect(pending.map((r) => r.id)).toEqual(["t1", "p1", "c1"]);
  });

  it("a tampered registry file can never direct the harness at a non-fixture resource", () => {
    const path = scratchRegistryPath();
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      kind: "v2_live_cleanup_registry",
      updatedAtIso: new Date().toISOString(),
      resources: [{ kind: "project", id: "p-real", name: "Production project", removed: false }],
    }));
    expect(() => pendingCleanupFromFile(readCleanupRegistryFile(path)))
      .toThrow(/live_resource_not_fixture_owned/);
  });
});

describe("B3: only a clean, confirmed, bypass-free, one-use-nonce run passes", () => {
  function registryWithOne(): LiveCleanupRegistry {
    const registry = new LiveCleanupRegistry();
    registry.record({ kind: "tag", id: "g1", name: `${LIVE_V2_PREFIX}tag` });
    return registry;
  }

  const PASSED_TAG_CASE = {
    id: "tag_create",
    actionName: "clockify_tags_create",
    status: "passed",
  } as const;
  const PASSED_PROJECT_CASE = {
    id: "project_create",
    actionName: "clockify_projects_create",
    status: "passed",
  } as const;

  it("passes a prepared-then-confirmed run with zero leftovers and every nonce proven one-use", () => {
    const report = buildLiveV2Report({
      workspaceId: FULL.workspaceId,
      cases: [PASSED_TAG_CASE],
      preparedWrites: 1,
      confirmedWrites: 1,
      nonceReplayRejections: 1,
      registry: registryWithOne(),
      removedIds: ["g1"],
    });
    expect(report.status).toBe("passed");
    expect(report.leftovers).toBe(0);
    expect(report.resourcesCreated).toBe(1);
    expect(report.resourcesRemoved).toBe(1);
    expect(report.leftoverKinds).toEqual([]);
    // The report the driver exits on carries the per-case verdicts.
    expect(report.plannedWrites).toBe(1);
    expect(report.cases).toEqual([PASSED_TAG_CASE]);
  });

  it("fails on ANY leftover and names its kind", () => {
    const report = buildLiveV2Report({
      workspaceId: FULL.workspaceId,
      cases: [PASSED_TAG_CASE],
      preparedWrites: 1,
      confirmedWrites: 1,
      nonceReplayRejections: 1,
      registry: registryWithOne(),
      removedIds: [],
    });
    expect(report.status).toBe("failed");
    expect(report.leftovers).toBe(1);
    expect(report.leftoverKinds).toEqual(["tag"]);
  });

  it("fails when preparation touched the host", () => {
    const report = buildLiveV2Report({
      cases: [PASSED_TAG_CASE],
      preparedWrites: 1,
      confirmedWrites: 1,
      nonceReplayRejections: 1,
      preparationMutations: 1,
      registry: registryWithOne(),
      removedIds: ["g1"],
    });
    expect(report.status).toBe("failed");
    expect(report.preparationMutations).toBe(1);
  });

  it("fails when the trusted immediate-write bypass was used instead of a confirmation", () => {
    const report = buildLiveV2Report({
      cases: [PASSED_TAG_CASE],
      preparedWrites: 1,
      confirmedWrites: 1,
      nonceReplayRejections: 1,
      trustedBypassCalls: 1,
      registry: registryWithOne(),
      removedIds: ["g1"],
    });
    expect(report.status).toBe("failed");
    expect(report.trustedBypassCalls).toBe(1);
  });

  it("fails when any confirmed write's nonce was NOT proven one-use", () => {
    const report = buildLiveV2Report({
      cases: [PASSED_TAG_CASE],
      preparedWrites: 1,
      confirmedWrites: 1,
      nonceReplayRejections: 0,
      registry: registryWithOne(),
      removedIds: ["g1"],
    });
    expect(report.status).toBe("failed");
  });

  it("fails when a confirmed creation could not be registered for cleanup", () => {
    const report = buildLiveV2Report({
      cases: [PASSED_TAG_CASE],
      preparedWrites: 1,
      confirmedWrites: 1,
      nonceReplayRejections: 1,
      untrackedCreations: 1,
      registry: registryWithOne(),
      removedIds: ["g1"],
    });
    expect(report.status).toBe("failed");
    expect(report.untrackedCreations).toBe(1);
  });

  it("fails a run that prepared nothing or confirmed nothing — an empty run is not a pass", () => {
    expect(buildLiveV2Report({ preparedWrites: 0, confirmedWrites: 0 }).status).toBe("failed");
    expect(buildLiveV2Report({ preparedWrites: 1, confirmedWrites: 0 }).status).toBe("failed");
  });

  it("fails when any prepared write was never confirmed, whatever the other counters say", () => {
    // The refuter's exact arithmetic probe: 2 prepared, 1 confirmed, 1 replay
    // rejection used to print "passed". It must never again.
    const aggregateOnly = buildLiveV2Report({
      workspaceId: FULL.workspaceId,
      preparedWrites: 2,
      confirmedWrites: 1,
      nonceReplayRejections: 1,
      registry: registryWithOne(),
      removedIds: ["g1"],
    });
    expect(aggregateOnly.status).toBe("failed");

    const withEvidence = buildLiveV2Report({
      workspaceId: FULL.workspaceId,
      cases: [PASSED_TAG_CASE, PASSED_PROJECT_CASE],
      preparedWrites: 2,
      confirmedWrites: 1,
      nonceReplayRejections: 1,
      registry: registryWithOne(),
      removedIds: ["g1"],
    });
    expect(withEvidence.status).toBe("failed");
  });

  it("fails when any single case failed, even with clean-looking aggregate counters", () => {
    const registry = registryWithOne();
    registry.record({ kind: "project", id: "p1", name: `${LIVE_V2_PREFIX}project` });
    const report = buildLiveV2Report({
      workspaceId: FULL.workspaceId,
      cases: [
        PASSED_TAG_CASE,
        {
          id: "project_create",
          actionName: "clockify_projects_create",
          status: "failed",
          failureCode: "event_order_violation",
        },
      ],
      preparedWrites: 2,
      confirmedWrites: 2,
      nonceReplayRejections: 2,
      registry,
      removedIds: ["g1", "p1"],
    });
    expect(report.status).toBe("failed");
    // The failure is NAMED in the emitted report, not buried in an aggregate.
    expect(report.cases[1]?.failureCode).toBe("event_order_violation");
  });

  it("never passes from aggregate counters alone — per-case evidence is required", () => {
    const report = buildLiveV2Report({
      workspaceId: FULL.workspaceId,
      preparedWrites: 1,
      confirmedWrites: 1,
      nonceReplayRejections: 1,
      registry: registryWithOne(),
      removedIds: ["g1"],
    });
    expect(report.status).toBe("failed");
  });

  it("fails when a planned case was silently dropped from the evidence", () => {
    const report = buildLiveV2Report({
      workspaceId: FULL.workspaceId,
      plannedWrites: 2,
      cases: [PASSED_TAG_CASE],
      preparedWrites: 1,
      confirmedWrites: 1,
      nonceReplayRejections: 1,
      registry: registryWithOne(),
      removedIds: ["g1"],
    });
    expect(report.status).toBe("failed");
  });

  it("fails when the counters disagree with the per-case evidence", () => {
    const report = buildLiveV2Report({
      workspaceId: FULL.workspaceId,
      cases: [PASSED_TAG_CASE, PASSED_PROJECT_CASE],
      preparedWrites: 1,
      confirmedWrites: 1,
      nonceReplayRejections: 1,
      registry: registryWithOne(),
      removedIds: ["g1"],
    });
    expect(report.status).toBe("failed");
  });

  it("reports refused with the exact missing preconditions and no resource claims", () => {
    const report = buildLiveV2Report({ preconditionFailures: ["live_opt_in_missing", "credentials_missing"] });
    expect(report.status).toBe("refused");
    expect(report.preconditionFailures).toEqual(["live_opt_in_missing", "credentials_missing"]);
    expect(report.resourcesCreated).toBe(0);
    expect(report.confirmedWrites).toBe(0);
  });

  it("reports not_executed when preconditions hold but the write authorization is absent", () => {
    const report = buildLiveV2Report({
      workspaceId: FULL.workspaceId,
      notExecuted: true,
    });
    expect(report.status).toBe("not_executed");
    expect(report.preparedWrites).toBe(0);
    expect(report.confirmedWrites).toBe(0);
    expect(report.resourcesCreated).toBe(0);
  });

  it("never carries a credential, a confirmation nonce, or the raw workspace id", () => {
    const report = buildLiveV2Report({
      workspaceId: FULL.workspaceId,
      cases: [PASSED_TAG_CASE],
      preparedWrites: 1,
      confirmedWrites: 1,
      nonceReplayRejections: 1,
      registry: registryWithOne(),
      removedIds: ["g1"],
    });
    expect(reportContainsSecret(report, [
      FULL.apiKey,
      FULL.workspaceId,
      "nonce-2f7c1a9b8d3e4f50",
    ])).toBe(false);
    // Only a bounded suffix survives, enough to correlate a run.
    expect(report.workspaceIdSuffix).toBe("b60e");
  });
});

describe("B3: the one-use replay probe can never execute a write", () => {
  const control = { id: "conf-1", nonce: "nonce-2f7c1a9b8d3e4f50" };
  const fixtureName = `${LIVE_V2_PREFIX}TAG_PROBE`;

  function probeHarness(responses: Array<{ status: number; body: unknown }>): {
    run: () => ReturnType<typeof confirmPreparedCase>;
    confirmCalls: Array<{ id: string; nonce: string }>;
    cancelCalls: string[];
    registry: LiveCleanupRegistry;
  } {
    const queue = [...responses];
    const confirmCalls: Array<{ id: string; nonce: string }> = [];
    const cancelCalls: string[] = [];
    const registry = new LiveCleanupRegistry();
    const run = (): ReturnType<typeof confirmPreparedCase> => confirmPreparedCase({
      control,
      chainCase: { resourceName: fixtureName },
      registry,
      postConfirm: (id, nonce) => {
        confirmCalls.push({ id, nonce });
        const next = queue.shift();
        if (!next) throw new Error("unexpected extra confirm POST");
        return Promise.resolve(next);
      },
      cancelPending: (id) => {
        cancelCalls.push(id);
        return Promise.resolve();
      },
    });
    return { run, confirmCalls, cancelCalls, registry };
  }

  function confirmedBody(created: Array<Record<string, unknown>>): unknown {
    return { ok: true, receipt: { ok: true, changed: { created } } };
  }

  it("NEVER replays the nonce after a denied confirm — a pre-commit denial does not burn it", async () => {
    // The real route (src/routes/confirmations.ts) answers a pre-commit denial
    // as 4xx JSON WITHOUT burning the nonce, so replaying it could EXECUTE the
    // write. The probe must not re-post; it disarms the pending preview instead.
    const harness = probeHarness([
      { status: 403, body: { ok: false, code: "role_check_failed" } },
    ]);
    const result = await harness.run();
    expect(harness.confirmCalls).toHaveLength(1);
    expect(result.confirmed).toBe(false);
    expect(result.nonceReplayProbed).toBe(false);
    expect(result.nonceReplayRejected).toBe(false);
    expect(result.createdRefs).toEqual([]);
    expect(harness.registry.size()).toBe(0);
    // The still-armed pending preview is cancelled, never left live.
    expect(harness.cancelCalls).toEqual([control.id]);
  });

  it("probes the replay only AFTER a real commit and requires its rejection", async () => {
    const harness = probeHarness([
      { status: 200, body: confirmedBody([{ type: "tag", id: "tag-1", name: fixtureName }]) },
      { status: 409, body: { ok: false, code: "not_pending" } },
    ]);
    const result = await harness.run();
    expect(harness.confirmCalls).toEqual([
      { id: control.id, nonce: control.nonce },
      { id: control.id, nonce: control.nonce },
    ]);
    expect(result.confirmed).toBe(true);
    expect(result.nonceReplayProbed).toBe(true);
    expect(result.nonceReplayRejected).toBe(true);
    expect(result.createdRefs.map((ref) => ref.id)).toEqual(["tag-1"]);
    expect(harness.registry.size()).toBe(1);
    expect(harness.cancelCalls).toEqual([]);
  });

  it("registers anything an (incorrectly) accepted replay created, so a duplicate stays cleanable", async () => {
    const harness = probeHarness([
      { status: 200, body: confirmedBody([{ type: "tag", id: "tag-1", name: fixtureName }]) },
      { status: 200, body: confirmedBody([{ type: "tag", id: "tag-2", name: fixtureName }]) },
    ]);
    const result = await harness.run();
    expect(result.nonceReplayProbed).toBe(true);
    expect(result.nonceReplayRejected).toBe(false);
    // BOTH the original and the duplicate are in the cleanup registry.
    expect(harness.registry.all().map((ref) => ref.id).sort()).toEqual(["tag-1", "tag-2"]);
    expect(result.createdRefs.map((ref) => ref.id).sort()).toEqual(["tag-1", "tag-2"]);
  });

  it("counts a confirmed write with no trackable creation as untracked", async () => {
    const harness = probeHarness([
      { status: 200, body: confirmedBody([]) },
      { status: 409, body: { ok: false, code: "not_pending" } },
    ]);
    const result = await harness.run();
    expect(result.confirmed).toBe(true);
    expect(result.untrackedCreations).toBe(1);
  });

  it("a failed cancel never crashes the case — the denial is already the failure", async () => {
    const registry = new LiveCleanupRegistry();
    const result = await confirmPreparedCase({
      control,
      chainCase: { resourceName: fixtureName },
      registry,
      postConfirm: () => Promise.resolve({ status: 403, body: { ok: false } }),
      cancelPending: () => Promise.reject(new Error("cancel route unreachable")),
    });
    expect(result.confirmed).toBe(false);
    expect(result.nonceReplayProbed).toBe(false);
  });
});

describe("B3: the driver can never use the trusted immediate-write bypass", () => {
  const driverSources = [
    "scripts/live-v2-full.ts",
    "scripts/lib/live-v2-contract.ts",
    "scripts/lib/live-v2-chain.ts",
  ];

  it("no driver source references executeTrustedDirect*", () => {
    for (const source of driverSources) {
      const content = readFileSync(join(process.cwd(), source), "utf8");
      expect(content, source).not.toMatch(/executeTrustedDirect/);
    }
  });

  it("the chain confirms through the stored confirmation nonce route", () => {
    const chain = readFileSync(join(process.cwd(), "scripts/lib/live-v2-chain.ts"), "utf8");
    expect(chain).toContain("/api/confirmations/");
    expect(chain).toContain("nonce");
  });
});
