/** The five branches a private v2 cutover can take, and the exact plan each one
 * produces. Every function here is PURE: it reads a plain input object and either
 * returns a plan or throws. Nothing in this module touches the filesystem, the
 * network, Railway, or Clockify -- the plan is computed and reviewed first, and a
 * caller executes it separately. That separation is the point: an incident-time
 * rollback must be decidable without running it. */
import { ROLLBACK_KEYS } from "./deploy-private-production.js";

export type CutoverBranch =
  | "preseed"
  | "automatic_rollback"
  | "signed_quarantine"
  | "signed_full_v1_rollback"
  | "post_reinstall_failure";

export interface CutoverIdentity {
  /** 40 lowercase hex. */
  candidateSha: string;
  /** 64 lowercase hex. */
  releaseBuildHash: string;
  assistantEngine: "v1" | "v2";
  /** An exact absolute path under /data/. */
  databasePath: string;
}

/** Narrowing the branch through the shared union proves at compile time that
 * every plan names one of the five recognized branches. */
interface CutoverPlanBase<Branch extends CutoverBranch> {
  branch: Branch;
}

function sameCutoverIdentity(left: CutoverIdentity, right: CutoverIdentity): boolean {
  return left.candidateSha === right.candidateSha
    && left.releaseBuildHash === right.releaseBuildHash
    && left.assistantEngine === right.assistantEngine
    && left.databasePath === right.databasePath;
}

/** Collects the eight rollback values, reporting every absent key rather than
 * only the first, so one review pass sees the whole gap. */
function collectRollbackVariables(
  prior: Readonly<Record<string, string>>,
): { variables: Record<string, string>; missing: string[] } {
  const variables: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of ROLLBACK_KEYS) {
    const value = prior[key];
    if (value === undefined) missing.push(key);
    else variables[key] = value;
  }
  return { variables, missing };
}

export interface PreseedInput {
  key: string;
  value: string;
  /** Railway's read-only pre-mutation variable snapshot. */
  existingKeys: readonly string[];
  assistantEngine: "v1" | "v2";
  /** The v1 identity recorded during rollback preparation. */
  recordedV1Identity: CutoverIdentity;
  /** The identity the service is actually running right now. */
  observedV1Identity: CutoverIdentity;
}

export interface PreseedPlan extends CutoverPlanBase<"preseed"> {
  key: string;
  variables: Record<string, string>;
}

/** A preseed adds one new variable to the STILL-v1 deployment. Overwriting an
 * existing key would silently change serving behavior, and preseeding onto a
 * deployment that has drifted from the recorded v1 identity would bind the
 * cutover to a release nobody reviewed. Checks run key -> engine -> identity, so
 * the operator is told about the key collision before anything else. */
export function planPreseed(input: PreseedInput): PreseedPlan {
  if (input.existingKeys.includes(input.key)) {
    throw new Error("preseed key must be absent or new");
  }
  if (input.assistantEngine !== "v1") {
    throw new Error("preseed must set engine v1");
  }
  if (!sameCutoverIdentity(input.recordedV1Identity, input.observedV1Identity)) {
    throw new Error("preseed requires unchanged v1 identity");
  }
  return {
    branch: "preseed",
    key: input.key,
    variables: { [input.key]: input.value },
  };
}

export interface AutomaticRollbackInput {
  /** Railway's pre-mutation snapshot of the eight rollback keys. */
  priorVariables: Readonly<Record<string, string>>;
}

export interface AutomaticRollbackPlan extends CutoverPlanBase<"automatic_rollback"> {
  variables: Record<string, string>;
}

/** The unsigned in-transaction rollback: restore all eight keys with one
 * no-deploy set. A key with no prior value cannot be restored that way (Railway
 * deletes cannot skip a deploy), so an incomplete snapshot must refuse BEFORE
 * the mutation rather than half-restore after it. */
export function planAutomaticRollback(input: AutomaticRollbackInput): AutomaticRollbackPlan {
  const { variables, missing } = collectRollbackVariables(input.priorVariables);
  if (missing.length > 0) {
    throw new Error(`automatic rollback is missing a prior value for: ${missing.join(", ")}`);
  }
  return { branch: "automatic_rollback", variables };
}

export interface SignedQuarantineInput {
  /** The owner's recorded authorization for this branch. */
  signature: string;
  quarantinedIdentity: CutoverIdentity;
}

export interface SignedQuarantinePlan extends CutoverPlanBase<"signed_quarantine"> {
  signature: string;
  quarantinedIdentity: CutoverIdentity;
}

/** Leaving a deployed v2 quarantined is a deliberate, recorded decision -- it is
 * the state a hard incident ends in -- so it may never be taken implicitly. */
export function planSignedQuarantine(input: SignedQuarantineInput): SignedQuarantinePlan {
  const signature = input.signature.trim();
  if (signature === "") {
    throw new Error("quarantine requires a recorded signature");
  }
  return {
    branch: "signed_quarantine",
    signature,
    quarantinedIdentity: input.quarantinedIdentity,
  };
}

export interface SignedFullV1RollbackInput {
  /** The owner's recorded authorization for this branch. */
  signature: string;
  /** The exact v1 source tree to restore. */
  restoreSource: string;
  /** 64 lowercase hex: the v1 release artifact this restore must reproduce. */
  restoreArtifactHash: string;
  /** The complete recorded v1 variable set: all eight rollback keys. */
  v1Variables: Readonly<Record<string, string>>;
  /** The v2 database this rollback abandons. */
  v2DatabasePath: string;
}

export interface SignedFullV1RollbackPlan extends CutoverPlanBase<"signed_full_v1_rollback"> {
  restoreSource: string;
  restoreArtifactHash: string;
  variables: Record<string, string>;
  restoreDatabasePath: string;
  /** See clearStaleInstallationSql: a restored v1 database still holds the
   * pre-outage installation row, so the rollback MUST clear it. */
  clearsStaleInstallation: true;
}

/** The signed full-v1 rollback: v1 source, v1 artifact, all eight variables, and
 * the v1 DATABASE. Restoring the v1 code while leaving the v2 database selected
 * would serve v1 against a database v1 never wrote, so the restored path is
 * checked against the abandoned v2 path explicitly. */
export function planSignedFullV1Rollback(
  input: SignedFullV1RollbackInput,
): SignedFullV1RollbackPlan {
  const signature = input.signature.trim();
  if (signature === "") {
    throw new Error("full v1 rollback requires a recorded signature");
  }
  const { variables, missing } = collectRollbackVariables(input.v1Variables);
  if (missing.length > 0) {
    throw new Error(`full v1 rollback is missing a v1 value for: ${missing.join(", ")}`);
  }
  const restoreDatabasePath = variables.DATABASE_PATH ?? "";
  if (restoreDatabasePath === input.v2DatabasePath) {
    throw new Error("full v1 rollback must restore the v1 database");
  }
  return {
    branch: "signed_full_v1_rollback",
    restoreSource: input.restoreSource,
    restoreArtifactHash: input.restoreArtifactHash,
    variables,
    restoreDatabasePath,
    clearsStaleInstallation: true,
  };
}

export interface PostReinstallFailureInput {
  /** The chosen disposition. Only one is permitted. */
  disposition: string;
  /** The exact cutover step that failed. */
  failedStep: string;
}

export interface PostReinstallFailurePlan extends CutoverPlanBase<"post_reinstall_failure"> {
  disposition: "full_v1_rollback";
  failedStep: string;
}

/** Once the reinstall has happened, installation authority has already moved to
 * the v2 database. There is no partial way back: the only permitted disposition
 * is the full v1 rollback. Anything else would leave authority split across two
 * databases. */
export function planPostReinstallFailure(
  input: PostReinstallFailureInput,
): PostReinstallFailurePlan {
  if (input.disposition !== "full_v1_rollback") {
    throw new Error("post-reinstall failure disposition must be full_v1_rollback");
  }
  return {
    branch: "post_reinstall_failure",
    disposition: "full_v1_rollback",
    failedStep: input.failedStep,
  };
}

/** Rollback restores a database whose installation row predates the outage, so a
 * post-rollback reinstall is not seen as fresh and its attestation is dropped.
 * The rollback must clear that row so the reinstall is genuinely fresh.
 *
 * `saveInstallation` deletes the prior attestation unconditionally and only
 * writes a new one when the installation row was genuinely ABSENT beforehand.
 * That strictness is deliberate and is not changed here: a restored v1 database
 * still carries the pre-outage row, so the reinstall would leave an active
 * installation with no attestation at all.
 *
 * Both statements are returned even though `installation_attestations` cascades
 * from `installations`: the cascade only fires with `PRAGMA foreign_keys = ON`,
 * and the `sqlite3` CLI an operator reaches for during an incident defaults it
 * OFF. The attestation delete must therefore come first and explicitly. */
export function clearStaleInstallationSql(workspaceId: string): string[] {
  if (workspaceId.trim() === "") {
    throw new Error("workspace id must be a nonempty identifier");
  }
  if (workspaceId.includes("'")) {
    throw new Error("workspace id must not contain a quote");
  }
  return [
    `DELETE FROM installation_attestations WHERE workspace_id = '${workspaceId}'`,
    `DELETE FROM installations WHERE workspace_id = '${workspaceId}'`,
  ];
}
