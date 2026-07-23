import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatRestoreVerificationFailure,
  verifyRestoredDatabase,
} from "../../src/db/restore-verification.js";
import { backupDatabase, restoreDatabase } from "../../src/db/recovery.js";
import { createStore } from "../../src/db/store.js";
import { LATEST_SCHEMA_VERSION } from "../../src/db/schema.js";

const ENCRYPTION_KEY = "restore-verification-test-key";
const TOKEN = "secret-addon-token-that-must-never-be-evidence";
const RELEASE_SHA = "a".repeat(40);
const RELEASE_BUILD_HASH = "b".repeat(64);
const SERVER_ARTIFACT_HASH = "c".repeat(64);
const tempDirectories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ai-assistant-restore-verify-"));
  tempDirectories.push(directory);
  return directory;
}

async function restoredFixture(options?: { userVersion?: number; apiUrlOverride?: string }): Promise<{
  restoredPath: string;
  checksumPath: string;
  metadataPath: string;
}> {
  const directory = tempDirectory();
  const sourcePath = join(directory, "source-with-private-name.sqlite");
  const backupPath = join(directory, "backup.sqlite");
  const restoredPath = join(directory, "isolated", "restored.sqlite");
  const store = createStore(sourcePath, { encryptionKey: ENCRYPTION_KEY });
  store.saveInstallation({
    workspaceId: "workspace-private-id",
    addonId: "addon-private-id",
    addonUserId: "addon-user-private-id",
    addonToken: TOKEN,
    apiUrl: "https://api.clockify.me/api",
  });
  store.close();
  if (options?.userVersion !== undefined || options?.apiUrlOverride !== undefined) {
    const db = new Database(sourcePath);
    if (options.userVersion !== undefined) {
      if (options.userVersion === 7) {
        db.exec("DROP TABLE lifecycle_authority_watermarks");
      }
      db.pragma(`user_version = ${String(options.userVersion)}`);
    }
    if (options.apiUrlOverride !== undefined) {
      db.prepare("UPDATE installations SET api_url = ?").run(options.apiUrlOverride);
    }
    db.close();
  }
  await backupDatabase({
    sourcePath,
    destinationPath: backupPath,
    now: () => new Date("2026-07-18T10:00:00.000Z"),
  });
  await restoreDatabase({ backupPath, targetPath: restoredPath });
  return {
    restoredPath,
    checksumPath: `${backupPath}.sha256`,
    metadataPath: `${backupPath}.json`,
  };
}

function deterministicTimer(): () => number {
  const values = [0, 4, 7, 9, 14, 15];
  return () => values.shift() ?? 15;
}

function readinessProof(overrides: Partial<{
  releaseSha: string;
  releaseBuildHash: string;
}> = {}) {
  return {
    endpoint: "GET /health" as const,
    httpStatus: 200 as const,
    startupInitialization: "production" as const,
    serverArtifact: "dist/server/server.js" as const,
    portBinding: "child_ephemeral_ipc" as const,
    releaseSha: overrides.releaseSha ?? RELEASE_SHA,
    releaseBuildHash: overrides.releaseBuildHash ?? RELEASE_BUILD_HASH,
    serverArtifactSha256: SERVER_ARTIFACT_HASH,
    readinessConfirmedAt: "2026-07-18T10:05:15.000Z",
    elapsedMs: 23,
    shutdownVerification: {
      childExitCode: 0 as const,
      databaseIntegrity: "ok" as const,
      writerLock: "available" as const,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("restored database verification", () => {
  it("emits stable secret-free checksum, schema, token-read, RTO, and RPO evidence", async () => {
    const fixture = await restoredFixture();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.clockify.me/api/v1/user");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("X-Addon-Token")).toBe(TOKEN);
      return new Response(JSON.stringify({ id: "private-user-id", name: "Private Person" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const evidence = await verifyRestoredDatabase({
      ...fixture,
      encryptionKey: ENCRYPTION_KEY,
      releaseSha: RELEASE_SHA,
      releaseBuildHash: RELEASE_BUILD_HASH,
      fetchImpl,
      monotonicNow: deterministicTimer(),
      drillStartedAt: "2026-07-18T10:05:00.000Z",
      incidentAt: "2026-07-18T10:05:00.000Z",
      applicationReadinessProbe: vi.fn(async (clonePath) => {
        expect(clonePath).not.toBe(fixture.restoredPath);
        expect(statSync(clonePath).mode & 0o777).toBe(0o600);
        return {
          ...readinessProof(),
          shutdownVerification: {
            ...readinessProof().shutdownVerification,
            internalDetail: TOKEN,
          },
        };
      }),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(evidence).toEqual({
      format: 1,
      conclusion: "passed",
      checks: {
        checksum: {
          status: "passed",
          algorithm: "sha256",
          bytes: readFileSync(fixture.restoredPath).byteLength,
          digest: createHash("sha256").update(readFileSync(fixture.restoredPath)).digest("hex"),
        },
        metadata: {
          status: "passed",
          format: 2,
          dataAsOf: "2026-07-18T10:00:00.000Z",
          backupCreatedAt: "2026-07-18T10:00:00.000Z",
        },
        integrity: {
          status: "passed",
          sourceResult: "ok",
          migratedResult: "ok",
        },
        schema: {
          status: "passed",
          sourceUserVersion: 10,
          userVersion: LATEST_SCHEMA_VERSION,
          migration: "not_required",
          requiredTables: 11,
          requiredColumns: 43,
        },
        installation: { status: "passed", activeCount: 1 },
        tokenBackedRead: {
          status: "passed",
          endpoint: "GET /user",
          httpStatus: 200,
          redirects: "blocked",
        },
        applicationReadiness: {
          status: "passed",
          endpoint: "GET /health",
          httpStatus: 200,
          startupInitialization: "production",
          serverArtifact: "dist/server/server.js",
          portBinding: "child_ephemeral_ipc",
          releaseSha: RELEASE_SHA,
          releaseBuildHash: RELEASE_BUILD_HASH,
          serverArtifactSha256: SERVER_ARTIFACT_HASH,
          shutdownVerification: {
            childExitCode: 0,
            databaseIntegrity: "ok",
            writerLock: "available",
          },
        },
      },
      timingsMs: {
        checksum: 4,
        integrity: 3,
        schema: 2,
        tokenBackedRead: 5,
        applicationReadiness: 23,
        total: 38,
      },
      recovery: {
        drillStartedAt: "2026-07-18T10:05:00.000Z",
        incidentAt: "2026-07-18T10:05:00.000Z",
        dataAsOf: "2026-07-18T10:00:00.000Z",
        backupCreatedAt: "2026-07-18T10:00:00.000Z",
        readinessConfirmedAt: "2026-07-18T10:05:15.000Z",
        rtoMs: 15_000,
        rpoMs: 300_000,
      },
    });

    const serialized = JSON.stringify(evidence);
    for (const privateValue of [
      TOKEN,
      "workspace-private-id",
      "addon-private-id",
      "addon-user-private-id",
      "private-user-id",
      "Private Person",
      fixture.restoredPath,
      "source-with-private-name.sqlite",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("runs every startup write on a private clone and leaves a symlinked caller path byte-identical", async () => {
    const fixture = await restoredFixture();
    const symlinkPath = `${fixture.restoredPath}.link`;
    symlinkSync(fixture.restoredPath, symlinkPath);
    const original = readFileSync(fixture.restoredPath);
    let clonePath = "";

    await verifyRestoredDatabase({
      ...fixture,
      restoredPath: symlinkPath,
      encryptionKey: ENCRYPTION_KEY,
      releaseSha: RELEASE_SHA,
      releaseBuildHash: RELEASE_BUILD_HASH,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ id: "user" }), { status: 200 })),
      applicationReadinessProbe: async (privateClonePath) => {
        clonePath = privateClonePath;
        expect(privateClonePath).not.toBe(symlinkPath);
        expect(privateClonePath).not.toBe(fixture.restoredPath);
        expect(statSync(privateClonePath).mode & 0o777).toBe(0o600);
        const clone = new Database(privateClonePath);
        clone.prepare("UPDATE readiness_probe SET checked_at = ? WHERE id = 1")
          .run("2026-07-18T10:05:15.000Z");
        clone.close();
        return readinessProof();
      },
    });

    expect(readFileSync(fixture.restoredPath)).toEqual(original);
    expect(existsSync(symlinkPath)).toBe(true);
    expect(existsSync(clonePath)).toBe(false);
  });

  it("validates a production-v7 source before migrating only a private clone to v9", async () => {
    const fixture = await restoredFixture({ userVersion: 7 });
    const original = readFileSync(fixture.restoredPath);

    const evidence = await verifyRestoredDatabase({
      ...fixture,
      encryptionKey: ENCRYPTION_KEY,
      releaseSha: RELEASE_SHA,
      releaseBuildHash: RELEASE_BUILD_HASH,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ id: "user" }), { status: 200 })),
      applicationReadinessProbe: async (privateClonePath) => {
        const before = new Database(privateClonePath, { readonly: true });
        expect(before.pragma("user_version", { simple: true })).toBe(7);
        expect(before.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'lifecycle_authority_watermarks'",
        ).get()).toEqual({ count: 0 });
        before.close();

        const migrated = createStore(privateClonePath, { encryptionKey: ENCRYPTION_KEY });
        migrated.close();
        return readinessProof();
      },
    });

    expect(evidence.checks.integrity).toEqual({
      status: "passed",
      sourceResult: "ok",
      migratedResult: "ok",
    });
    expect(evidence.checks.schema).toEqual({
      status: "passed",
      sourceUserVersion: 7,
      userVersion: LATEST_SCHEMA_VERSION,
      migration: "candidate_private_clone",
      requiredTables: 11,
      requiredColumns: 43,
    });
    expect(readFileSync(fixture.restoredPath)).toEqual(original);
  });

  it("fails closed when the candidate readiness probe does not migrate a v7 clone", async () => {
    const fixture = await restoredFixture({ userVersion: 7 });

    await expect(verifyRestoredDatabase({
      ...fixture,
      encryptionKey: ENCRYPTION_KEY,
      releaseSha: RELEASE_SHA,
      releaseBuildHash: RELEASE_BUILD_HASH,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ id: "user" }), { status: 200 })),
      applicationReadinessProbe: async () => readinessProof(),
    })).rejects.toMatchObject({
      check: "schema",
      code: "post_migration_schema_mismatch",
    });
  });

  it("removes the private clone when application startup fails", async () => {
    const fixture = await restoredFixture();
    let clonePath = "";

    await expect(verifyRestoredDatabase({
      ...fixture,
      encryptionKey: ENCRYPTION_KEY,
      releaseSha: RELEASE_SHA,
      releaseBuildHash: RELEASE_BUILD_HASH,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ id: "user" }), { status: 200 })),
      applicationReadinessProbe: async (privateClonePath) => {
        clonePath = privateClonePath;
        throw new Error("private failure");
      },
    })).rejects.toMatchObject({
      check: "application_readiness",
      code: "readiness_probe_failed",
    });
    expect(clonePath).not.toBe("");
    expect(existsSync(clonePath)).toBe(false);
  });

  it("rejects stale version-1 backup metadata for release evidence", async () => {
    const fixture = await restoredFixture();
    const metadata = JSON.parse(readFileSync(fixture.metadataPath, "utf8")) as Record<string, unknown>;
    delete metadata.dataAsOf;
    metadata.format = 1;
    writeFileSync(fixture.metadataPath, `${JSON.stringify(metadata)}\n`);

    await expect(verifyRestoredDatabase({
      ...fixture,
      encryptionKey: ENCRYPTION_KEY,
      releaseSha: RELEASE_SHA,
      releaseBuildHash: RELEASE_BUILD_HASH,
      fetchImpl: vi.fn(),
      applicationReadinessProbe: vi.fn(),
    })).rejects.toMatchObject({ check: "metadata", code: "stale_metadata" });
  });

  it("rejects application proof from a different release identity", async () => {
    const fixture = await restoredFixture();
    await expect(verifyRestoredDatabase({
      ...fixture,
      encryptionKey: ENCRYPTION_KEY,
      releaseSha: RELEASE_SHA,
      releaseBuildHash: RELEASE_BUILD_HASH,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ id: "user" }), { status: 200 })),
      applicationReadinessProbe: async () => readinessProof({ releaseSha: "c".repeat(40) }),
    })).rejects.toMatchObject({
      check: "application_readiness",
      code: "release_identity_mismatch",
    });
  });

  it("calculates RPO from conservative dataAsOf rather than later sidecar creation", async () => {
    const fixture = await restoredFixture();
    const metadata = JSON.parse(readFileSync(fixture.metadataPath, "utf8")) as Record<string, unknown>;
    metadata.dataAsOf = "2026-07-18T09:55:00.000Z";
    writeFileSync(fixture.metadataPath, `${JSON.stringify(metadata)}\n`);

    const evidence = await verifyRestoredDatabase({
      ...fixture,
      encryptionKey: ENCRYPTION_KEY,
      releaseSha: RELEASE_SHA,
      releaseBuildHash: RELEASE_BUILD_HASH,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ id: "user" }), { status: 200 })),
      drillStartedAt: "2026-07-18T10:05:00.000Z",
      incidentAt: "2026-07-18T10:05:00.000Z",
      applicationReadinessProbe: async () => readinessProof(),
    });

    expect(evidence.recovery).toMatchObject({
      dataAsOf: "2026-07-18T09:55:00.000Z",
      rpoMs: 600_000,
    });
  });

  it("refuses to call static verification restore-to-ready evidence without an application readiness probe", async () => {
    const fixture = await restoredFixture();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "user" }), { status: 200 }));

    await expect(verifyRestoredDatabase({
      ...fixture,
      encryptionKey: ENCRYPTION_KEY,
      releaseSha: RELEASE_SHA,
      releaseBuildHash: RELEASE_BUILD_HASH,
      fetchImpl,
      drillStartedAt: "2026-07-18T10:05:00.000Z",
      incidentAt: "2026-07-18T10:05:00.000Z",
      applicationReadinessProbe: undefined as never,
    })).rejects.toMatchObject({
      check: "application_readiness",
      code: "readiness_probe_required",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sanitizes arbitrary one-off application startup failures", async () => {
    const fixture = await restoredFixture();
    const privateFailure = `failed for ${TOKEN} at ${fixture.restoredPath}`;
    let caught: unknown;
    try {
      await verifyRestoredDatabase({
        ...fixture,
      encryptionKey: ENCRYPTION_KEY,
      releaseSha: RELEASE_SHA,
      releaseBuildHash: RELEASE_BUILD_HASH,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ id: "user" }), { status: 200 })),
        applicationReadinessProbe: async () => {
          throw new Error(privateFailure);
        },
      });
    } catch (error) {
      caught = error;
    }

    const failure = formatRestoreVerificationFailure(caught);
    expect(failure).toEqual({
      format: 1,
      conclusion: "failed",
      failedCheck: "application_readiness",
      errorCode: "readiness_probe_failed",
    });
    expect(JSON.stringify(failure)).not.toContain(TOKEN);
    expect(JSON.stringify(failure)).not.toContain(fixture.restoredPath);
  });

  it("fails closed when the restored candidate does not match the SHA-256 sidecar", async () => {
    const fixture = await restoredFixture();
    writeFileSync(fixture.restoredPath, "tampered-restored-candidate");

    await expect(verifyRestoredDatabase({
      ...fixture,
      encryptionKey: ENCRYPTION_KEY,
      releaseSha: RELEASE_SHA,
      releaseBuildHash: RELEASE_BUILD_HASH,
      fetchImpl: vi.fn(),
      applicationReadinessProbe: vi.fn(),
    })).rejects.toMatchObject({ check: "checksum", code: "checksum_mismatch" });
  });

  it("rejects a structurally valid backup whose schema version is not current", async () => {
    const fixture = await restoredFixture({ userVersion: 6 });

    await expect(verifyRestoredDatabase({
      ...fixture,
      encryptionKey: ENCRYPTION_KEY,
      releaseSha: RELEASE_SHA,
      releaseBuildHash: RELEASE_BUILD_HASH,
      fetchImpl: vi.fn(),
      applicationReadinessProbe: vi.fn(),
    })).rejects.toMatchObject({ check: "schema", code: "schema_version_mismatch" });
  });

  it("never includes a Clockify response body or private data in failure evidence", async () => {
    const fixture = await restoredFixture();
    let responseBodyRead = false;
    const privateBody = JSON.stringify({
      workspaceId: "workspace-private-id",
      token: TOKEN,
      message: "private-host-error-body",
    });
    const response = new Response(privateBody, { status: 401 });
    const originalText = response.text.bind(response);
    response.text = async () => {
      responseBodyRead = true;
      return originalText();
    };

    let caught: unknown;
    try {
      await verifyRestoredDatabase({
        ...fixture,
        encryptionKey: ENCRYPTION_KEY,
        releaseSha: RELEASE_SHA,
        releaseBuildHash: RELEASE_BUILD_HASH,
        fetchImpl: vi.fn(async () => response),
        applicationReadinessProbe: vi.fn(),
      });
    } catch (error) {
      caught = error;
    }
    const failure = formatRestoreVerificationFailure(caught);
    expect(failure).toEqual({
      format: 1,
      conclusion: "failed",
      failedCheck: "token_backed_read",
      errorCode: "http_status",
      httpStatus: 401,
    });
    expect(responseBodyRead).toBe(false);
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain(privateBody);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("workspace-private-id");
    expect(serialized).not.toContain(fixture.restoredPath);
  });

  it("sanitizes a restored installation with an invalid Clockify service origin", async () => {
    const privateUrl = "https://private-invalid-origin.example.com/api";
    const fixture = await restoredFixture({ apiUrlOverride: privateUrl });
    let caught: unknown;
    try {
      await verifyRestoredDatabase({
        ...fixture,
        encryptionKey: ENCRYPTION_KEY,
        releaseSha: RELEASE_SHA,
        releaseBuildHash: RELEASE_BUILD_HASH,
        fetchImpl: vi.fn(),
        applicationReadinessProbe: vi.fn(),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ check: "installation", code: "invalid_service_url" });
    expect(JSON.stringify(formatRestoreVerificationFailure(caught))).not.toContain(privateUrl);
  });
});
