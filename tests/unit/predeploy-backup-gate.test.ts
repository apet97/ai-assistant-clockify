import { describe, expect, it } from "vitest";

import { validatePredeployBackupGate } from "../../scripts/evidence/predeploy-backup-gate.js";
import { LATEST_SCHEMA_VERSION } from "../../src/db/schema.js";

const RELEASE_SHA = "a".repeat(40);
const BUILD_HASH = "b".repeat(64);
const ARTIFACT_HASH = "c".repeat(64);
const BACKUP_HASH = "d".repeat(64);
const GATE_NOW = new Date("2026-07-19T00:30:00.000Z");

function gateInput() {
  return {
    releaseSha: RELEASE_SHA,
    releaseBuildHash: BUILD_HASH,
    serverArtifactSha256: ARTIFACT_HASH,
    backupSha256: BACKUP_HASH,
    checksumSha256: BACKUP_HASH,
    backupBytes: 42,
    expectedSourceDatabasePath: "/data/ai-assistant.sqlite",
    metadata: {
      format: 2,
      dataAsOf: "2026-07-18T23:55:00.000Z",
      createdAt: "2026-07-19T00:00:00.000Z",
      bytes: 42,
      sha256: BACKUP_HASH,
      source: "/data/ai-assistant.sqlite",
    },
    restoreEvidence: {
      format: 1,
      conclusion: "passed",
      checks: {
        checksum: { status: "passed", algorithm: "sha256", bytes: 42, digest: BACKUP_HASH },
        metadata: {
          status: "passed",
          format: 2,
          dataAsOf: "2026-07-18T23:55:00.000Z",
          backupCreatedAt: "2026-07-19T00:00:00.000Z",
        },
        integrity: { status: "passed", sourceResult: "ok", migratedResult: "ok" },
        schema: {
          status: "passed",
          sourceUserVersion: 7,
          userVersion: LATEST_SCHEMA_VERSION,
          migration: "candidate_private_clone",
          requiredTables: 11,
          requiredColumns: 43,
        },
        installation: { status: "passed", activeCount: 1 },
        tokenBackedRead: { status: "passed", endpoint: "GET /user", httpStatus: 200, redirects: "blocked" },
        applicationReadiness: {
          status: "passed",
          endpoint: "GET /health",
          httpStatus: 200,
          startupInitialization: "production",
          serverArtifact: "dist/server/server.js",
          portBinding: "child_ephemeral_ipc",
          releaseSha: RELEASE_SHA,
          releaseBuildHash: BUILD_HASH,
          serverArtifactSha256: ARTIFACT_HASH,
          shutdownVerification: { childExitCode: 0, databaseIntegrity: "ok", writerLock: "available" },
        },
      },
      timingsMs: {
        checksum: 10,
        integrity: 10,
        schema: 10,
        tokenBackedRead: 10,
        applicationReadiness: 10,
        total: 50,
      },
      recovery: {
        drillStartedAt: "2026-07-19T00:00:00.000Z",
        incidentAt: "2026-07-19T00:00:00.000Z",
        dataAsOf: "2026-07-18T23:55:00.000Z",
        backupCreatedAt: "2026-07-19T00:00:00.000Z",
        readinessConfirmedAt: "2026-07-19T00:00:15.000Z",
        rtoMs: 15_000,
        rpoMs: 300_000,
      },
    },
  };
}

describe("predeploy encrypted-backup stop gate", () => {
  it("accepts a backup whose bytes, sidecars, restore drill, and release identity all agree", () => {
    expect(() => validatePredeployBackupGate(gateInput(), { now: GATE_NOW })).not.toThrow();
  });

  it("rejects stale sidecars and restore proof for different release bytes", () => {
    const staleSidecar = gateInput();
    staleSidecar.checksumSha256 = "e".repeat(64);
    expect(() => validatePredeployBackupGate(staleSidecar, { now: GATE_NOW })).toThrow(/checksum/u);

    const staleRestore = gateInput();
    staleRestore.restoreEvidence.checks.applicationReadiness.releaseSha = "f".repeat(40);
    expect(() => validatePredeployBackupGate(staleRestore, { now: GATE_NOW })).toThrow(/restore release SHA/u);
  });

  it("rejects an otherwise valid backup and restore proof once the one-hour upload window expires", () => {
    const input = gateInput();
    expect(() => validatePredeployBackupGate(input, {
      now: new Date("2026-07-19T01:00:00.001Z"),
    })).toThrow(/backup.*stale/u);
  });

  it("accepts the exact one-hour freshness boundary", () => {
    const input = gateInput();
    expect(() => validatePredeployBackupGate(input, {
      now: new Date("2026-07-19T01:00:00.000Z"),
    })).not.toThrow();
  });

  it("rejects future-dated backup or restore evidence", () => {
    const futureBackup = gateInput();
    expect(() => validatePredeployBackupGate(futureBackup, {
      now: new Date("2026-07-18T23:59:59.999Z"),
    })).toThrow(/backup.*future/u);

    const futureRestore = gateInput();
    futureRestore.metadata.createdAt = "2026-07-18T23:59:00.000Z";
    futureRestore.restoreEvidence.checks.metadata.backupCreatedAt = futureRestore.metadata.createdAt;
    futureRestore.restoreEvidence.recovery.backupCreatedAt = futureRestore.metadata.createdAt;
    futureRestore.restoreEvidence.recovery.incidentAt = "2026-07-18T23:59:00.000Z";
    futureRestore.restoreEvidence.recovery.drillStartedAt = "2026-07-18T23:59:00.000Z";
    futureRestore.restoreEvidence.recovery.rpoMs = 240_000;
    futureRestore.restoreEvidence.recovery.rtoMs = 75_000;
    expect(() => validatePredeployBackupGate(futureRestore, {
      now: new Date("2026-07-19T00:00:14.999Z"),
    })).toThrow(/restore.*future/u);
  });

  it("rejects a misordered backup, incident, drill, or readiness timeline", () => {
    const dataAfterBackup = gateInput();
    dataAfterBackup.metadata.dataAsOf = "2026-07-19T00:00:05.000Z";
    dataAfterBackup.restoreEvidence.checks.metadata.dataAsOf = dataAfterBackup.metadata.dataAsOf;
    dataAfterBackup.restoreEvidence.recovery.dataAsOf = dataAfterBackup.metadata.dataAsOf;
    dataAfterBackup.restoreEvidence.recovery.incidentAt = "2026-07-19T00:00:10.000Z";
    dataAfterBackup.restoreEvidence.recovery.drillStartedAt = "2026-07-19T00:00:10.000Z";
    dataAfterBackup.restoreEvidence.recovery.rpoMs = 5_000;
    dataAfterBackup.restoreEvidence.recovery.rtoMs = 5_000;
    expect(() => validatePredeployBackupGate(dataAfterBackup, { now: GATE_NOW })).toThrow(/timeline/u);

    const backupAfterIncident = gateInput();
    backupAfterIncident.restoreEvidence.recovery.incidentAt = "2026-07-18T23:59:59.999Z";
    backupAfterIncident.restoreEvidence.recovery.rpoMs = 299_999;
    expect(() => validatePredeployBackupGate(backupAfterIncident, { now: GATE_NOW })).toThrow(/timeline/u);

    const incidentAfterDrillStarted = gateInput();
    incidentAfterDrillStarted.restoreEvidence.recovery.incidentAt = "2026-07-19T00:00:10.000Z";
    incidentAfterDrillStarted.restoreEvidence.recovery.rpoMs = 310_000;
    expect(() => validatePredeployBackupGate(incidentAfterDrillStarted, { now: GATE_NOW })).toThrow(/timeline/u);
  });

  it("rejects a valid backup taken from a different database than the deploy protects", () => {
    // The v2 cutover puts TWO databases on the volume. A backup of the wrong one
    // is still internally perfect -- correct checksum, correct byte count, clean
    // integrity, real schema, fresh timestamps -- so only the recorded source
    // distinguishes it. `backupDatabase` has always written `metadata.source`;
    // nothing read it until now.
    const wrongDatabase = gateInput();
    wrongDatabase.metadata.source = "/data/ai-assistant-v2.sqlite";
    expect(() => validatePredeployBackupGate(wrongDatabase, { now: GATE_NOW }))
      .toThrow(/different database than this deploy protects/u);

    // Backing up the new empty target instead of the live database is the exact
    // mistake this catches, and it must not be satisfiable by relabelling.
    const relabelled = gateInput();
    relabelled.expectedSourceDatabasePath = "/data/ai-assistant-v2.sqlite";
    expect(() => validatePredeployBackupGate(relabelled, { now: GATE_NOW }))
      .toThrow(/different database than this deploy protects/u);

    for (const source of [undefined, "", 42]) {
      const unrecorded = gateInput();
      (unrecorded.metadata as Record<string, unknown>).source = source;
      expect(() => validatePredeployBackupGate(unrecorded, { now: GATE_NOW }))
        .toThrow(/does not record its source database/u);
    }
  });
});
