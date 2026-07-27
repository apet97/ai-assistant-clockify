import { describe, expect, it } from "vitest";
import {
  clearStaleInstallationSql,
  planAutomaticRollback,
  planPostReinstallFailure,
  planPreseed,
  planSignedFullV1Rollback,
  planSignedQuarantine,
  type CutoverIdentity,
} from "../../scripts/cutover-transaction.js";

/** Written out literally, in order, rather than imported from the module under
 * test: the eight keys and their order are part of the contract this file pins. */
const ROLLBACK_KEY_NAMES = [
  "RELEASE_SHA",
  "RELEASE_BUILD_HASH",
  "RELEASE_SOURCE_BINDING_SHA256",
  "LLM_MODEL",
  "LLM_REASONING_EFFORT",
  "LLM_THINKING_MODE",
  "ASSISTANT_ENGINE",
  "DATABASE_PATH",
] as const;

const V1_DATABASE_PATH = "/data/ai-assistant.sqlite";
const V2_DATABASE_PATH = "/data/ai-assistant-v2.sqlite";

const v1Identity: CutoverIdentity = {
  candidateSha: "1".repeat(40),
  releaseBuildHash: "2".repeat(64),
  assistantEngine: "v1",
  databasePath: V1_DATABASE_PATH,
};

const v2Identity: CutoverIdentity = {
  candidateSha: "a".repeat(40),
  releaseBuildHash: "b".repeat(64),
  assistantEngine: "v2",
  databasePath: V2_DATABASE_PATH,
};

const v1Variables = {
  RELEASE_SHA: "1".repeat(40),
  RELEASE_BUILD_HASH: "2".repeat(64),
  RELEASE_SOURCE_BINDING_SHA256: "3".repeat(64),
  LLM_MODEL: "deepseek-v4-pro",
  LLM_REASONING_EFFORT: "medium",
  LLM_THINKING_MODE: "disabled",
  ASSISTANT_ENGINE: "v1",
  DATABASE_PATH: V1_DATABASE_PATH,
};

const preseedInput = () => ({
  key: "ASSISTANT_ENGINE_PRESEED",
  value: "v2",
  existingKeys: ["RELEASE_SHA", "ASSISTANT_ENGINE", "DATABASE_PATH"],
  assistantEngine: "v1" as const,
  recordedV1Identity: v1Identity,
  observedV1Identity: v1Identity,
});

const fullV1RollbackInput = () => ({
  signature: "owner-grant-2026-07-27",
  restoreSource: "/tmp/v1-candidate-source",
  restoreArtifactHash: "4".repeat(64),
  v1Variables,
  v2DatabasePath: V2_DATABASE_PATH,
});

describe("private v2 cutover branch planning", () => {
  it("plans a preseed for an absent key on the unchanged v1 deployment", () => {
    expect(planPreseed(preseedInput())).toEqual({
      branch: "preseed",
      key: "ASSISTANT_ENGINE_PRESEED",
      variables: { ASSISTANT_ENGINE_PRESEED: "v2" },
    });
  });

  it("refuses to preseed over a key that already has a serving value", () => {
    expect(() => planPreseed({ ...preseedInput(), key: "DATABASE_PATH" }))
      .toThrow("preseed key must be absent or new");
    // A collision is reported before anything else, so the operator learns the
    // key is already in service rather than being sent to check identity drift.
    expect(() => planPreseed({
      ...preseedInput(),
      key: "DATABASE_PATH",
      assistantEngine: "v2",
      observedV1Identity: v2Identity,
    })).toThrow("preseed key must be absent or new");
  });

  it("refuses a preseed that would move the serving engine off v1", () => {
    // The preseed lands while v1 is still serving; only the later checked deploy
    // transaction may change the engine.
    expect(() => planPreseed({ ...preseedInput(), assistantEngine: "v2" }))
      .toThrow("preseed must set engine v1");
    expect(() => planPreseed({
      ...preseedInput(),
      assistantEngine: "v2",
      observedV1Identity: v2Identity,
    })).toThrow("preseed must set engine v1");
  });

  it("refuses a preseed onto a deployment that drifted from the recorded v1 identity", () => {
    for (const drift of [
      { candidateSha: "9".repeat(40) },
      { releaseBuildHash: "9".repeat(64) },
      { assistantEngine: "v2" as const },
      { databasePath: V2_DATABASE_PATH },
    ]) {
      expect(() => planPreseed({
        ...preseedInput(),
        observedV1Identity: { ...v1Identity, ...drift },
      })).toThrow("preseed requires unchanged v1 identity");
    }
  });

  it("plans an automatic rollback over all eight keys when every prior exists", () => {
    expect(planAutomaticRollback({ priorVariables: v1Variables })).toEqual({
      branch: "automatic_rollback",
      variables: {
        RELEASE_SHA: "1".repeat(40),
        RELEASE_BUILD_HASH: "2".repeat(64),
        RELEASE_SOURCE_BINDING_SHA256: "3".repeat(64),
        LLM_MODEL: "deepseek-v4-pro",
        LLM_REASONING_EFFORT: "medium",
        LLM_THINKING_MODE: "disabled",
        ASSISTANT_ENGINE: "v1",
        DATABASE_PATH: V1_DATABASE_PATH,
      },
    });
  });

  it.each(ROLLBACK_KEY_NAMES)(
    "refuses an automatic rollback with no prior value for %s",
    (key) => {
      // Railway deletes cannot skip a deploy, so a key with no prior value
      // cannot be restored by the one no-deploy set this branch is allowed.
      const partial: Record<string, string> = { ...v1Variables };
      delete partial[key];
      expect(() => planAutomaticRollback({ priorVariables: partial }))
        .toThrow(`automatic rollback is missing a prior value for: ${key}`);
    },
  );

  it("refuses to quarantine a deployed v2 without a recorded signature", () => {
    for (const signature of ["", "   "]) {
      expect(() => planSignedQuarantine({ signature, quarantinedIdentity: v2Identity }))
        .toThrow("quarantine requires a recorded signature");
    }
    expect(planSignedQuarantine({
      signature: "owner-grant-2026-07-27",
      quarantinedIdentity: v2Identity,
    })).toEqual({
      branch: "signed_quarantine",
      signature: "owner-grant-2026-07-27",
      quarantinedIdentity: v2Identity,
    });
  });

  it("plans a signed full v1 rollback with all eight variables and the stale-row clear", () => {
    expect(planSignedFullV1Rollback(fullV1RollbackInput())).toEqual({
      branch: "signed_full_v1_rollback",
      restoreSource: "/tmp/v1-candidate-source",
      restoreArtifactHash: "4".repeat(64),
      variables: {
        RELEASE_SHA: "1".repeat(40),
        RELEASE_BUILD_HASH: "2".repeat(64),
        RELEASE_SOURCE_BINDING_SHA256: "3".repeat(64),
        LLM_MODEL: "deepseek-v4-pro",
        LLM_REASONING_EFFORT: "medium",
        LLM_THINKING_MODE: "disabled",
        ASSISTANT_ENGINE: "v1",
        DATABASE_PATH: V1_DATABASE_PATH,
      },
      restoreDatabasePath: V1_DATABASE_PATH,
      clearsStaleInstallation: true,
    });

    // An unsigned rollback is refused before the database paths are compared.
    for (const signature of ["", "   "]) {
      expect(() => planSignedFullV1Rollback({ ...fullV1RollbackInput(), signature }))
        .toThrow("full v1 rollback requires a recorded signature");
      expect(() => planSignedFullV1Rollback({
        ...fullV1RollbackInput(),
        signature,
        v1Variables: { ...v1Variables, DATABASE_PATH: V2_DATABASE_PATH },
      })).toThrow("full v1 rollback requires a recorded signature");
    }

    // A rollback cannot restore a variable set it does not fully hold.
    const partial: Record<string, string> = { ...v1Variables };
    delete partial.LLM_MODEL;
    expect(() => planSignedFullV1Rollback({ ...fullV1RollbackInput(), v1Variables: partial }))
      .toThrow("full v1 rollback is missing a v1 value for: LLM_MODEL");
  });

  it("refuses a full v1 rollback that would leave the v2 database selected", () => {
    // Restoring v1 code against the v2 database would serve v1 against a
    // database v1 never wrote.
    expect(() => planSignedFullV1Rollback({
      ...fullV1RollbackInput(),
      v1Variables: { ...v1Variables, DATABASE_PATH: V2_DATABASE_PATH },
    })).toThrow("full v1 rollback must restore the v1 database");
  });

  it("permits only the full v1 rollback disposition after the reinstall", () => {
    expect(planPostReinstallFailure({
      disposition: "full_v1_rollback",
      failedStep: "T18-H",
    })).toEqual({
      branch: "post_reinstall_failure",
      disposition: "full_v1_rollback",
      failedStep: "T18-H",
    });
    for (const disposition of ["", "quarantine", "automatic_rollback", "preseed", "roll_forward"]) {
      expect(() => planPostReinstallFailure({ disposition, failedStep: "T18-H" }))
        .toThrow("post-reinstall failure disposition must be full_v1_rollback");
    }
  });

  it("clears the stale attestation before the stale installation row", () => {
    expect(clearStaleInstallationSql("64ad1305c701cc5be7c26fe4")).toEqual([
      "DELETE FROM installation_attestations WHERE workspace_id = '64ad1305c701cc5be7c26fe4'",
      "DELETE FROM installations WHERE workspace_id = '64ad1305c701cc5be7c26fe4'",
    ]);
  });

  it("refuses a workspace id that is empty or carries a quote", () => {
    for (const workspaceId of ["", "   ", "\t\n"]) {
      expect(() => clearStaleInstallationSql(workspaceId))
        .toThrow("workspace id must be a nonempty identifier");
    }
    for (const workspaceId of ["64ad'1305", "'", "x' OR '1'='1"]) {
      expect(() => clearStaleInstallationSql(workspaceId))
        .toThrow("workspace id must not contain a quote");
    }
  });
});
