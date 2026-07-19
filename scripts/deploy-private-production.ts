import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PROJECT_ID = "fb1fa3c6-cc28-40d8-b985-2a7ee7051304";
const SERVICE = "ai-assistant";
const ENVIRONMENT = "production";
const ROLLBACK_KEYS = [
  "RELEASE_SHA",
  "RELEASE_BUILD_HASH",
  "RELEASE_SOURCE_BINDING_SHA256",
  "LLM_MODEL",
  "LLM_REASONING_EFFORT",
  "LLM_THINKING_MODE",
] as const;

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
  return {
    RELEASE_SHA: exactHash(required(environment, "RELEASE_SHA"), 40, "RELEASE_SHA"),
    RELEASE_BUILD_HASH: exactHash(required(environment, "RELEASE_BUILD_HASH"), 64, "RELEASE_BUILD_HASH"),
    RELEASE_SOURCE_BINDING_SHA256: exactHash(
      required(environment, "RELEASE_SOURCE_BINDING_SHA256"),
      64,
      "RELEASE_SOURCE_BINDING_SHA256",
    ),
    LLM_MODEL: required(environment, "SELECTED_LLM_MODEL"),
    ...(reasoning === "unset" ? {} : { LLM_REASONING_EFFORT: reasoning }),
    ...(thinking === "disabled" ? { LLM_THINKING_MODE: "disabled" } : {}),
  };
}

export function assertRollbackCoverage(
  snapshot: RollbackVariableSnapshot,
  desired: Record<string, string>,
): void {
  const missing = Object.keys(desired).filter((key) => !Object.hasOwn(snapshot, key));
  if (missing.length > 0) {
    throw new Error(
      `Refusing to mutate variables without a no-deploy rollback value for: ${missing.join(", ")}`,
    );
  }
}

function variableArgs(command: "list" | "set"): string[] {
  return ["variable", command, "-p", PROJECT_ID, "-s", SERVICE, "-e", ENVIRONMENT];
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

export function deployPrivateProduction(
  environment: NodeJS.ProcessEnv = process.env,
  commandRunner: DeployCommandRunner = run,
): void {
  const staging = resolve(required(environment, "RELEASE_STAGING"));
  if (!statSync(staging).isDirectory()) throw new Error("RELEASE_STAGING must be a directory");
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
    commandRunner("railway", ["up", staging, "--path-as-root", "-p", PROJECT_ID, "-s", SERVICE,
      "-e", ENVIRONMENT, "--ci", "--message", `marketplace-1.0.0 ${desired.RELEASE_SHA}`]);
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
