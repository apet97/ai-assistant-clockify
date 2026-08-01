import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { verifyReleaseSourceBinding } from "./lib/release-artifact-identity.js";
import { assertProductVersion } from "./lib/candidate-product-version.js";

const PROJECT_ID = "fb1fa3c6-cc28-40d8-b985-2a7ee7051304";
const SERVICE_ID = "2656670e-39a5-40f3-af5c-56dfc637552f";
const ENVIRONMENT_ID = "45300bdc-788b-4f63-8749-5a8f7e46b774";
// ASSISTANT_ENGINE and DATABASE_PATH are rollback keys, not merely deploy
// inputs. Restoring only the RELEASE_*/LLM_* keys after a failed upload would
// leave the PRIOR code serving with the NEW engine and database selection --
// for the v2 cutover that means v1 code pointed at an empty v2 database with
// engine v2, the worst reachable state.
// Exported so the cutover branch planner in ./cutover-transaction.ts plans a
// rollback over the exact same eight keys this transaction snapshots, rather
// than a second copy that could drift.
export const ROLLBACK_KEYS = [
  "RELEASE_SHA",
  "RELEASE_BUILD_HASH",
  "RELEASE_SOURCE_BINDING_SHA256",
  "LLM_MODEL",
  "LLM_REASONING_EFFORT",
  "LLM_THINKING_MODE",
  "ASSISTANT_ENGINE",
  "DATABASE_PATH",
  "DATABASE_PATH_DISPOSITION",
] as const;

const ASSISTANT_ENGINES = new Set(["v1", "v2"]);

/** A deploy either expects to create a brand-new database file at an unused
 * path, or to reopen one that must already exist. There is no third case, and
 * neither may be inferred: a typo'd path silently creates an empty database
 * that then migrates to the latest schema and looks perfectly healthy. */
const DATABASE_DISPOSITIONS = new Set(["new_unused", "existing_expected"]);

type RollbackKey = typeof ROLLBACK_KEYS[number];
export type RollbackVariableSnapshot = Partial<Record<RollbackKey, string>>;

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function exactHash(value: string, length: 40 | 64, key: string): string {
  if (!new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value)) {
    throw new Error(`${key} must be an exact lowercase ${length}-character hash`);
  }
  return value;
}

export function parseRollbackVariableSnapshot(raw: string): RollbackVariableSnapshot {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Railway variable response must be an object");
  }
  const values = parsed as Record<string, unknown>;
  const snapshot: RollbackVariableSnapshot = {};
  for (const key of ROLLBACK_KEYS) {
    if (!(key in values)) continue;
    if (typeof values[key] !== "string") throw new Error(`Railway variable ${key} must be a string`);
    snapshot[key] = values[key];
  }
  return snapshot;
}

export function desiredReleaseVariables(
  environment: NodeJS.ProcessEnv,
  existing: RollbackVariableSnapshot = {},
): Record<string, string> {
  const thinking = required(environment, "SELECTED_THINKING_MODE");
  const reasoning = required(environment, "SELECTED_REASONING_EFFORT");
  if (thinking !== "disabled" && thinking !== "unset") {
    throw new Error("SELECTED_THINKING_MODE must be disabled or unset");
  }
  if (reasoning === "unset" && existing.LLM_REASONING_EFFORT !== undefined) {
    throw new Error("LLM_REASONING_EFFORT must already be absent when the selected setting is unset");
  }
  if (thinking === "unset" && existing.LLM_THINKING_MODE !== undefined) {
    throw new Error("LLM_THINKING_MODE must already be absent when the selected setting is unset");
  }
  const engine = required(environment, "SELECTED_ASSISTANT_ENGINE");
  if (!ASSISTANT_ENGINES.has(engine)) {
    throw new Error("SELECTED_ASSISTANT_ENGINE must be v1 or v2");
  }
  const databasePath = selectedDatabasePath(environment);
  const disposition = required(environment, "SELECTED_DATABASE_PATH_DISPOSITION");
  if (!DATABASE_DISPOSITIONS.has(disposition)) {
    throw new Error("SELECTED_DATABASE_PATH_DISPOSITION must be new_unused or existing_expected");
  }
  // A path declared unused may not be the one already in service, and a path
  // declared to exist may not be a path this deploy is introducing. Both
  // directions are checked against the read-only pre-mutation snapshot, so the
  // claim is verified against Railway's own current state rather than trusted.
  if (disposition === "new_unused" && existing.DATABASE_PATH === databasePath) {
    throw new Error("SELECTED_DATABASE_PATH is already the deployed database path and cannot be new_unused");
  }
  if (disposition === "existing_expected" && existing.DATABASE_PATH !== databasePath) {
    throw new Error("SELECTED_DATABASE_PATH is not the deployed database path and cannot be existing_expected");
  }
  // F24: an ADR-fresh v2 transition (the deployed engine is not yet v2) must
  // move to a NEW unused database path. Reusing the in-service database for a
  // v2 cutover is exactly the recorded ADR-001 violation. The only way past
  // this rule is the review's option 2 — a FORMAL, owner-recorded ADR
  // supersession — stated explicitly; silence never passes.
  if (
    engine === "v2"
    && existing.ASSISTANT_ENGINE !== undefined
    && existing.ASSISTANT_ENGINE !== "v2"
    && disposition === "existing_expected"
    && environment.SELECTED_ADR001_DECISION !== "superseded_in_place_migration"
  ) {
    throw new Error(
      "An ADR-fresh v2 transition requires SELECTED_DATABASE_PATH_DISPOSITION=new_unused. "
        + "Reusing the deployed database needs an owner-recorded ADR-001 supersession, stated as "
        + "SELECTED_ADR001_DECISION=superseded_in_place_migration.",
    );
  }
  return {
    RELEASE_SHA: exactHash(required(environment, "RELEASE_SHA"), 40, "RELEASE_SHA"),
    RELEASE_BUILD_HASH: exactHash(required(environment, "RELEASE_BUILD_HASH"), 64, "RELEASE_BUILD_HASH"),
    RELEASE_SOURCE_BINDING_SHA256: exactHash(
      required(environment, "RELEASE_SOURCE_BINDING_SHA256"),
      64,
      "RELEASE_SOURCE_BINDING_SHA256",
    ),
    LLM_MODEL: required(environment, "SELECTED_LLM_MODEL"),
    ASSISTANT_ENGINE: engine,
    DATABASE_PATH: databasePath,
    // F24: the runtime PROVES a `new_unused` claim before opening the database
    // (src/db/fresh-boundary.ts), so the disposition travels with the release.
    DATABASE_PATH_DISPOSITION: disposition,
    ...(reasoning === "unset" ? {} : { LLM_REASONING_EFFORT: reasoning }),
    ...(thinking === "disabled" ? { LLM_THINKING_MODE: "disabled" } : {}),
  };
}

/** The database lives on the Railway volume at /data. Anything else is either a
 * typo or an ephemeral container path that silently loses every install on the
 * next redeploy. */
export function selectedDatabasePath(environment: NodeJS.ProcessEnv): string {
  const value = required(environment, "SELECTED_DATABASE_PATH");
  if (!value.startsWith("/data/") || value.includes("..") || value.endsWith("/")) {
    throw new Error("SELECTED_DATABASE_PATH must be an exact absolute path under /data");
  }
  return value;
}

/**
 * Variables this transaction may INTRODUCE without a prior value. A rollback
 * leaves an introduced variable set, which must be provably harmless: the
 * restored artifact predates `DATABASE_PATH_DISPOSITION` and ignores it, and
 * the next deploy snapshots it normally. Every other desired variable still
 * requires a no-deploy rollback value.
 */
export const INTRODUCIBLE_KEYS = new Set(["DATABASE_PATH_DISPOSITION"]);

export function assertRollbackCoverage(
  snapshot: RollbackVariableSnapshot,
  desired: Record<string, string>,
): void {
  const missing = Object.keys(desired)
    .filter((key) => !INTRODUCIBLE_KEYS.has(key))
    .filter((key) => !Object.hasOwn(snapshot, key));
  if (missing.length > 0) {
    throw new Error(
      `Refusing to mutate variables without a no-deploy rollback value for: ${missing.join(", ")}`,
    );
  }
}

function variableArgs(command: "list" | "set"): string[] {
  return ["variable", command, "-p", PROJECT_ID, "-s", SERVICE_ID, "-e", ENVIRONMENT_ID];
}

export type DeployCommandRunner = (command: string, args: string[], capture?: boolean) => string;

const run: DeployCommandRunner = (command, args, capture = false) => {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : ["ignore", "ignore", "inherit"],
  });
};

function rollbackVariables(
  snapshot: RollbackVariableSnapshot,
  mutatedKeys: string[],
  commandRunner: DeployCommandRunner,
): void {
  const failures: string[] = [];
  for (const rawKey of mutatedKeys) {
    if (!ROLLBACK_KEYS.includes(rawKey as RollbackKey)) continue;
    const key = rawKey as RollbackKey;
    try {
      if (!Object.hasOwn(snapshot, key)) throw new Error("rollback value missing");
      commandRunner("railway", [
        ...variableArgs("set"),
        "--skip-deploys",
        `${key}=${snapshot[key] ?? ""}`,
      ]);
    } catch {
      failures.push(key);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Railway variable rollback failed for: ${failures.join(", ")}`);
  }
}

/** Rehashes the staged tree and binds it to the candidate SHA + build hash.
 * Injectable only so the transaction-ordering tests need not materialize a real
 * archive; the DEFAULT is the real verifier, and `rejects staged bytes that are
 * not the candidate` exercises it against a real staging directory. */
export type StagedSourceVerifier = (input: {
  sourceRoot: string;
  releaseSha: string;
  releaseBuildHash: string;
  sourceBindingSha256: string;
}) => void;

export function deployPrivateProduction(
  environment: NodeJS.ProcessEnv = process.env,
  commandRunner: DeployCommandRunner = run,
  verifyStagedSource: StagedSourceVerifier = verifyReleaseSourceBinding,
): void {
  const staging = resolve(required(environment, "RELEASE_STAGING"));
  if (!statSync(staging).isDirectory()) throw new Error("RELEASE_STAGING must be a directory");
  // The deployment label must name the version being UPLOADED. `staging` is the
  // extracted `git archive` of the candidate, so a v1 rollback and a v2 deploy
  // each get their OWN candidate's version in the label. Reading the mutable
  // checkout instead would mislabel exactly the rollback case this transaction
  // exists to protect, and a literal would mislabel one engine unconditionally.
  const stagedProductVersion = assertProductVersion(
    (JSON.parse(readFileSync(join(staging, "package.json"), "utf8")) as { version?: unknown }).version,
    "staged candidate product version",
  );
  // The bytes about to be uploaded must BE the candidate. Checking only that
  // the staging path is a directory left the binding to procedural shell in the
  // runbook, so an edited or stale staging tree would upload silently. This
  // rehashes the real staged tree and requires it to match both the candidate
  // SHA and RELEASE_BUILD_HASH before any variable is touched.
  verifyStagedSource({
    sourceRoot: staging,
    releaseSha: exactHash(required(environment, "RELEASE_SHA"), 40, "RELEASE_SHA"),
    releaseBuildHash: exactHash(required(environment, "RELEASE_BUILD_HASH"), 64, "RELEASE_BUILD_HASH"),
    sourceBindingSha256: exactHash(
      required(environment, "RELEASE_SOURCE_BINDING_SHA256"),
      64,
      "RELEASE_SOURCE_BINDING_SHA256",
    ),
  });
  const rollbackSourceDir = resolve(required(environment, "ROLLBACK_SOURCE_DIR"));
  // A rollback that has no source tree to go back to is not a rollback. This is
  // required BEFORE the upload precisely so the failure happens while the prior
  // release is still serving.
  if (!statSync(rollbackSourceDir).isDirectory()) {
    throw new Error("ROLLBACK_SOURCE_DIR must be an existing directory");
  }
  if (rollbackSourceDir === staging) {
    throw new Error("ROLLBACK_SOURCE_DIR must not be the candidate staging directory");
  }
  const railwayVersion = commandRunner("railway", ["--version"], true).trim();
  if (!railwayVersion.includes("5.27.0")) throw new Error("Railway CLI 5.27.0 is required");

  // This stop gate is deliberately inside the checked deploy transaction and
  // immediately precedes the read-only snapshot plus first variable mutation.
  commandRunner("npm", ["run", "--silent", "gate:predeploy-backup"]);
  const snapshot = parseRollbackVariableSnapshot(
    commandRunner("railway", [...variableArgs("list"), "--json"], true),
  );
  const desired = desiredReleaseVariables(environment, snapshot);
  // Railway deletes cannot be marked --skip-deploys. This existing-service
  // transaction therefore refuses to introduce a key that could not be
  // restored with one no-deploy set if the source upload fails.
  assertRollbackCoverage(snapshot, desired);
  // Mutation begins before this batch call: a CLI/network error can arrive
  // after Railway accepted any subset of the values. Both this set and the
  // following source upload therefore share one rollback boundary.
  try {
    commandRunner("railway", [
      ...variableArgs("set"),
      "--skip-deploys",
      ...Object.entries(desired).map(([key, value]) => `${key}=${value}`),
    ]);
    commandRunner("railway", ["up", staging, "--path-as-root", "-p", PROJECT_ID, "-s", SERVICE_ID,
      "-e", ENVIRONMENT_ID, "--ci", "--message", `marketplace-${stagedProductVersion} ${desired.RELEASE_SHA}`]);
  } catch (releaseError) {
    try {
      rollbackVariables(snapshot, Object.keys(desired), commandRunner);
    } catch {
      throw new Error("Railway release failed and the prior variable state could not be fully restored");
    }
    throw new Error("Railway variable mutation or upload failed; prior release and model variables were restored", {
      cause: releaseError,
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    deployPrivateProduction();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Private production deploy failed");
    process.exit(1);
  }
}
