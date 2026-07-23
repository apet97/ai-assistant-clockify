import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { probeRestoredApplicationReadiness } from "../../scripts/lib/restored-app-readiness.js";
import { createStore } from "../../src/db/store.js";
import { restoredDatabaseTestFixture } from "../helpers/restored-database-fixture.js";

const RELEASE_SHA = "a".repeat(40);
const RELEASE_BUILD_HASH = "b".repeat(64);
const SERVER_ARTIFACT_HASH = "c".repeat(64);
const MANIFEST_PATH = resolve("dist/release-artifact-manifest.json");
let originalManifest: Buffer;

// The cryptographic source/archive/artifact binding uses a real temporary Git
// repository in release-artifact-identity.test.ts. Isolate the later production
// startup, IPC, health, shutdown, and database-lock path in this suite.
vi.mock("../../scripts/lib/release-artifact-identity.js", () => ({
  ReleaseArtifactIdentityError: class ReleaseArtifactIdentityError extends Error {
    readonly code = "test_error";
  },
  verifyBuiltReleaseArtifact: vi.fn((input: { releaseSha: string; releaseBuildHash: string }) => ({
    sourceCandidateSha: input.releaseSha,
    sourceArchiveSha256: input.releaseBuildHash,
    sourceRelationship: "exact_head",
    serverArtifact: "dist/server",
    serverArtifactSha256: "c".repeat(64),
  })),
}));

beforeAll(() => {
  originalManifest = readFileSync(MANIFEST_PATH);
  const manifest = JSON.parse(originalManifest.toString("utf8")) as Record<string, unknown>;
  manifest.sourceCandidateSha = RELEASE_SHA;
  manifest.sourceArchiveSha256 = RELEASE_BUILD_HASH;
  manifest.buildHeadSha = RELEASE_SHA;
  manifest.sourceRelationship = "exact_head";
  manifest.sourceBindingSha256 = null;
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
});

afterAll(() => {
  writeFileSync(MANIFEST_PATH, originalManifest);
});

describe("restored application readiness probe", () => {
  it("boots the production startup path against the isolated restore, proves /health, and stops cleanly", async () => {
    const fixture = await restoredDatabaseTestFixture();
    try {
      const store = createStore(fixture.restoredPath, { encryptionKey: fixture.encryptionKey });
      store.saveInstallation({
        workspaceId: "workspace-interrupted-delete",
        addonId: "addon-interrupted-delete",
        addonUserId: "user-interrupted-delete",
        addonToken: "token-interrupted-delete",
      });
      store.tombstoneInstallation("workspace-interrupted-delete");
      store.close();

      const proof = await probeRestoredApplicationReadiness({
        restoredPath: fixture.restoredPath,
        encryptionKey: fixture.encryptionKey,
        releaseSha: RELEASE_SHA,
        releaseBuildHash: RELEASE_BUILD_HASH,
        timeoutMs: 15_000,
      });

      expect(proof).toMatchObject({
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
      });
      expect(Date.parse(proof.readinessConfirmedAt)).not.toBeNaN();
      expect(proof.elapsedMs).toBeGreaterThanOrEqual(0);

      const db = new Database(fixture.restoredPath, { readonly: true });
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM installations WHERE workspace_id = ?",
      ).get("workspace-interrupted-delete")).toEqual({ count: 0 });
      db.close();
    } finally {
      fixture.cleanup();
    }
  }, 20_000);

  it("boots the exact production artifact on a v7 clone and leaves it migrated to v9", async () => {
    const fixture = await restoredDatabaseTestFixture();
    try {
      const legacy = new Database(fixture.restoredPath);
      legacy.exec("DROP TABLE lifecycle_authority_watermarks; PRAGMA user_version = 7;");
      legacy.close();

      const proof = await probeRestoredApplicationReadiness({
        restoredPath: fixture.restoredPath,
        encryptionKey: fixture.encryptionKey,
        releaseSha: RELEASE_SHA,
        releaseBuildHash: RELEASE_BUILD_HASH,
        timeoutMs: 15_000,
      });

      expect(proof.shutdownVerification).toEqual({
        childExitCode: 0,
        databaseIntegrity: "ok",
        writerLock: "available",
      });
      const migrated = new Database(fixture.restoredPath, { readonly: true });
      expect(migrated.pragma("user_version", { simple: true })).toBe(9);
      expect(migrated.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'lifecycle_authority_watermarks'",
      ).get()).toEqual({ count: 1 });
      expect(migrated.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'assistant_runs'",
      ).get()).toEqual({ count: 1 });
      migrated.close();
    } finally {
      fixture.cleanup();
    }
  }, 20_000);

  it("fails closed when the built child reports a different release identity", async () => {
    const fixture = await restoredDatabaseTestFixture();
    try {
      await expect(probeRestoredApplicationReadiness({
        restoredPath: fixture.restoredPath,
        encryptionKey: fixture.encryptionKey,
        releaseSha: RELEASE_SHA,
        releaseBuildHash: RELEASE_BUILD_HASH,
        timeoutMs: 15_000,
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/version")) {
            return new Response(JSON.stringify({
              releaseSha: "c".repeat(40),
              buildHash: RELEASE_BUILD_HASH,
            }), { status: 200 });
          }
          return await fetch(input, init);
        },
      })).rejects.toMatchObject({
        check: "application_readiness",
        code: "instance_identity_mismatch",
      });
    } finally {
      fixture.cleanup();
    }
  }, 20_000);

  it("requires an actual release identity before spawning the production artifact", async () => {
    const fixture = await restoredDatabaseTestFixture();
    try {
      await expect(probeRestoredApplicationReadiness({
        restoredPath: fixture.restoredPath,
        encryptionKey: fixture.encryptionKey,
        releaseSha: "",
        releaseBuildHash: "",
      })).rejects.toMatchObject({
        check: "application_readiness",
        code: "release_identity_required",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("fails shutdown verification while another writer still owns the restored database", async () => {
    const fixture = await restoredDatabaseTestFixture();
    let writer: Database.Database | undefined;
    try {
      await expect(probeRestoredApplicationReadiness({
        restoredPath: fixture.restoredPath,
        encryptionKey: fixture.encryptionKey,
        releaseSha: RELEASE_SHA,
        releaseBuildHash: RELEASE_BUILD_HASH,
        timeoutMs: 15_000,
        fetchImpl: async (input, init) => {
          const response = await fetch(input, init);
          if (String(input).endsWith("/health") && response.status === 200 && !writer) {
            const body = await response.text();
            writer = new Database(fixture.restoredPath);
            writer.pragma("busy_timeout = 5000");
            writer.exec("BEGIN IMMEDIATE");
            return new Response(body, {
              status: response.status,
              headers: response.headers,
            });
          }
          return response;
        },
      })).rejects.toMatchObject({
        check: "application_readiness",
        code: "writer_lock_unavailable",
      });
    } finally {
      if (writer?.inTransaction) writer.exec("ROLLBACK");
      writer?.close();
      fixture.cleanup();
    }
  }, 20_000);
});
