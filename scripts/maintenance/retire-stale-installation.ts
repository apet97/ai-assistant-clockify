/**
 * Purpose-built, audited maintenance retirement of ONE stale installation
 * (closure-plan PR 11 / Operation 11B, F15). For an installation whose token
 * external reality already rejects (repeated authenticated 401s), an operator
 * retires the row deliberately — never ad hoc SQL, never an automatic reaction
 * to a transient wire response.
 *
 * DRY-RUN FIRST: without --execute the command only prints the sanitized row
 * and what WOULD happen. It refuses unless the operator restates the exact
 * row — workspace, generation, and status must all match — and requires a
 * token-failure evidence file recording the operator-verified 401 probe.
 * On execute it retires the token fingerprint, wipes the ciphertext, bumps
 * the generation, leaves the row INACTIVE (workspace data is NOT erased), and
 * writes a secret-free audit record.
 *
 *   DATABASE_PATH=/data/ai-assistant.sqlite DATA_ENCRYPTION_KEY=<key> \
 *     npx tsx scripts/maintenance/retire-stale-installation.ts \
 *     --workspace <24-hex> --expect-generation <n> --expect-status active \
 *     --evidence token-failure.json [--operator <name>] [--execute]
 *
 * The evidence JSON must be `{"probedAt":"<ISO>","httpStatus":401,"host":"<origin>"}`.
 * Run against a stopped server (or restart afterwards) so the in-process
 * lifecycle coordinator observes the retired state.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { createStore } from "../../src/db/store.js";

function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}
loadDotEnv();

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

const EvidenceSchema = z.object({
  probedAt: z.string().datetime({ offset: true }),
  httpStatus: z.literal(401),
  host: z.string().min(1).max(200),
}).strict();

function fail(code: string, detail: string): never {
  console.error(`REFUSED (${code}): ${detail}`);
  process.exit(2);
}

const databasePath = process.env.DATABASE_PATH;
const encryptionKey = process.env.DATA_ENCRYPTION_KEY;
const workspaceId = argValue("--workspace");
const expectGenerationRaw = argValue("--expect-generation");
const expectStatus = argValue("--expect-status");
const evidencePath = argValue("--evidence");
const operator = argValue("--operator") ?? "maintenance-operator";
const execute = process.argv.includes("--execute");

if (!databasePath || !encryptionKey) {
  fail("missing_env", "DATABASE_PATH and DATA_ENCRYPTION_KEY are required.");
}
if (!workspaceId || !/^[0-9a-f]{24}$/.test(workspaceId)) {
  fail("invalid_workspace", "--workspace must be the exact 24-hex workspace id.");
}
const expectedGeneration = Number(expectGenerationRaw);
if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
  fail("invalid_generation", "--expect-generation must be a positive integer.");
}
if (expectStatus !== "active" && expectStatus !== "inactive") {
  fail("invalid_status", "--expect-status must be 'active' or 'inactive'.");
}
if (!evidencePath || !existsSync(evidencePath)) {
  fail("missing_evidence", "--evidence must point to the token-failure evidence JSON.");
}
let evidence: z.infer<typeof EvidenceSchema>;
try {
  evidence = EvidenceSchema.parse(JSON.parse(readFileSync(evidencePath, "utf8")));
} catch (error) {
  fail("invalid_evidence", `evidence must be {probedAt, httpStatus: 401, host}: ${error instanceof Error ? error.message : String(error)}`);
}

const store = createStore(databasePath, { encryptionKey });
try {
  const installation = store.getInstallation(workspaceId);
  if (!installation) fail("not_found", "no installation row for that workspace.");
  // Sanitized state only — NEVER the token or its ciphertext.
  console.log(JSON.stringify({
    mode: execute ? "execute" : "dry_run",
    workspaceId,
    status: installation.status,
    generation: installation.generation,
    hasToken: installation.addonToken !== "",
    evidence,
  }, null, 2));
  if (installation.generation !== expectedGeneration) {
    fail("generation_mismatch", `row generation is ${installation.generation}, expected ${expectedGeneration}.`);
  }
  if (installation.status !== expectStatus) {
    fail("status_mismatch", `row status is ${installation.status}, expected ${expectStatus}.`);
  }
  if (!execute) {
    console.log("DRY RUN: all preconditions match. Re-run with --execute to retire "
      + "(denylist token fingerprint, wipe ciphertext, bump generation, set inactive).");
    process.exit(0);
  }

  const result = store.retireInstallationForMaintenance({
    workspaceId,
    expectedGeneration,
    expectedStatus: expectStatus,
  });
  if (result.outcome !== "retired") {
    fail(result.outcome, `store refused the retirement: ${JSON.stringify(result)}`);
  }
  // Secret-free audit record binding the act to the operator and the evidence.
  store.addAuditEvent({
    workspaceId,
    adminUserId: operator,
    actionName: "maintenance_installation_retire",
    risk: ["permission_change"],
    receipt: {
      ok: true,
      code: "installation_retired",
      generationBefore: expectedGeneration,
      generationAfter: result.generation,
      previousStatus: expectStatus,
      tokenFingerprintRetired: result.tokenFingerprintRetired,
      evidence,
      operator,
    },
  });
  console.log(JSON.stringify({
    outcome: "retired",
    generation: result.generation,
    tokenFingerprintRetired: result.tokenFingerprintRetired,
  }, null, 2));
  console.log("Retired. Restart the server (or run this only against a stopped server) "
    + "so the lifecycle coordinator observes the new state.");
} finally {
  store.close();
}
