import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLiveV2Report,
  decideLiveV2Execution,
  LIVE_V2_WRITE_AUTHORIZATION_VALUE,
  LIVE_V2_WRITE_AUTHORIZATION_VARIABLE,
  PersistedCleanupRegistry,
  reportContainsSecret,
  type LiveV2Report,
} from "./lib/live-v2-contract.js";
import {
  buildReportFromChainOutcome,
  runLiveV2DryRun,
  runV2WriteChain,
  type ChainOutcome,
} from "./lib/live-v2-chain.js";

/**
 * B3 (`npm run live:v2-full`): the guarded sacrificial v2 live-write driver.
 *
 * It drives the REAL v2 flow only — the exact chain in both modes:
 *
 *   assistant turn (real v2 runner) -> OperationPreparationService with ZERO
 *     external mutations pre-confirm -> the STORED confirmation nonce through
 *     ConfirmationService (POST /api/confirmations/:id/confirm, the
 *     button-equivalent path) -> truthful receipt -> a rejected same-nonce
 *     replay probe (the one-use proof; probed ONLY after a real commit, since
 *     a pre-commit denial never burns the nonce — after a denial the probe
 *     cancels the still-armed preview instead of re-posting it) ->
 *     reverse-dependency-order cleanup.
 *
 * It never uses the trusted immediate-write bypass — that path exists for
 * direct UI origins and must never stand in for a confirmed assistant write in
 * acceptance evidence (pinned by a source-scan unit test).
 *
 * MODES
 *   --dry-run   Prove the chain against the FAKE Clockify host: no credentials,
 *               no preconditions, a fetch guard blocks all network. Exit 0 only
 *               on an honest `passed` report.
 *   (default)   LIVE mode. Refuses without ALL FIVE preconditions, and even
 *               with them performs no write without the separate per-step
 *               authorization variable below.
 *
 * THE FIVE PRECONDITIONS (all required; a missing one is a refusal):
 *   1. LIVE_CLOCKIFY=1                          — the live opt-in.
 *   2. LIVE_SACRIFICIAL_WORKSPACE_MARKER        — the literal
 *      "clockify-live-smoke-sacrificial"; a workspace id alone is never proof
 *      a workspace is disposable.
 *   3. LIVE_CLOCKIFY_API_KEY                    — sacrificial-workspace key.
 *   4. LIVE_WORKSPACE_ID                        — the sacrificial workspace.
 *   5. LIVE_V2_CLEANUP_REGISTRY_PATH            — CONSUMED, not decorative:
 *      every created entity is persisted there AS IT IS CREATED, so an
 *      interrupted run stays cleanable in reverse dependency order
 *      (`pendingCleanupFromFile`).
 *
 * THE SEPARATE PER-STEP LIVE-WRITE AUTHORIZATION (replaces the old prose-only
 * "T18-H" step): LIVE_V2_WRITE_AUTHORIZATION=execute-sacrificial-v2-writes.
 * Preconditions prove the TARGET is sacrificial; this variable is the
 * operator's explicit instruction to execute writes in THIS invocation.
 * Without it the driver reports `not_executed` and makes no Clockify call.
 *
 * REPORT STATUS (honest, never a fake pass) and EXIT CODES:
 *   refused      exit 2 — a precondition is missing; nothing ran.
 *   not_executed exit 3 — preconditions hold, authorization absent; nothing ran.
 *   failed       exit 1 — the chain ran and any check failed (a leftover, a
 *                pre-confirm mutation, an accepted nonce replay, an untracked
 *                creation, an unconfirmed write, a dropped case, or ANY
 *                case-level failure code).
 *   passed       exit 0 — every planned write case present in the per-case
 *                evidence and judged passed, every write previewed,
 *                button-confirmed, receipted, nonce-proven one-use, and
 *                cleaned to zero leftovers.
 *
 * Both modes exit on the SAME report construction
 * (`buildReportFromChainOutcome`): the report carries every per-case verdict
 * (bounded literals only — case id, action name, status, failure code), and
 * its pass condition requires complete, all-passed per-case evidence whose
 * aggregate counters agree (prepared == planned == cases, confirmed ==
 * prepared, one rejected replay per confirmed write). Aggregate arithmetic
 * alone can never produce a pass.
 */

export {
  buildLiveV2Report,
  checkLivePreconditions,
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
} from "./lib/live-v2-contract.js";
export type {
  CleanupRegistryView,
  LivePreconditionFailure,
  LivePreconditionInput,
  LivePreconditionResult,
  LiveResource,
  LiveResourceKind,
  LiveV2CaseReport,
  LiveV2ExecutionDecision,
  LiveV2Report,
  PersistedRegistryFile,
  PersistedRegistryFileEntry,
} from "./lib/live-v2-contract.js";
export {
  buildReportFromChainOutcome,
  confirmPreparedCase,
  defaultChainCases,
  DRY_RUN_ADMIN_USER_ID,
  DRY_RUN_WORKSPACE_ID,
  runLiveV2DryRun,
  runV2WriteChain,
} from "./lib/live-v2-chain.js";
export type {
  ChainCaseEvidence,
  ChainOutcome,
  ChainWriteCase,
  ConfirmProbeOutcome,
} from "./lib/live-v2-chain.js";

function emitReport(report: LiveV2Report, outcome?: ChainOutcome): boolean {
  // Belt and braces on top of the report's bounded shape: if a nonce somehow
  // reached the serialized report, refuse to print it at all.
  const secrets = outcome ? outcome.collectedNonces : [];
  if (reportContainsSecret(report, secrets)) {
    process.stderr.write("live_v2_report_withheld: a confirmation nonce reached the report.\n");
    return false;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return true;
}

async function runDryRunMode(): Promise<number> {
  const cleanupRegistryPath = process.env.LIVE_V2_CLEANUP_REGISTRY_PATH
    ?? join(mkdtempSync(join(tmpdir(), "live-v2-dry-run-")), "registry.json");
  process.stderr.write(`live_v2_dry_run: fake host only, cleanup registry at ${cleanupRegistryPath}\n`);
  const { report, outcome } = await runLiveV2DryRun({ cleanupRegistryPath });
  if (!emitReport(report, outcome)) return 1;
  return report.status === "passed" ? 0 : 1;
}

async function runLiveMode(): Promise<number> {
  const decision = decideLiveV2Execution(process.env as Record<string, string | undefined>);
  if (decision.kind === "refused") {
    // Refusal is the correct outcome without full authorization. No Clockify
    // call is made, and the report says exactly what was missing.
    emitReport(buildLiveV2Report({ preconditionFailures: decision.failures }));
    return 2;
  }
  if (decision.kind === "not_executed") {
    emitReport(buildLiveV2Report({ workspaceId: decision.workspaceId, notExecuted: true }));
    process.stderr.write(
      "live_v2_full_not_executed: preconditions satisfied, but executing sacrificial live "
      + `writes requires ${LIVE_V2_WRITE_AUTHORIZATION_VARIABLE}=${LIVE_V2_WRITE_AUTHORIZATION_VALUE} `
      + "(the separate per-step live-write authorization).\n",
    );
    return 3;
  }

  // Full authorization: the SAME chain the dry run proved, with the real REST
  // adapter injected. Composed lazily so no live module loads before this point.
  const { createRestWorkspaceClient } = await import("../src/clockify/rest-workspace.js");
  const baseUrl = (process.env.LIVE_BASE_URL ?? "https://api.clockify.me/api/v1").replace(/\/$/, "");
  const adminUserId = await resolveLiveAdminUserId(baseUrl, decision.apiKey);
  const clockify = createRestWorkspaceClient({
    baseUrl,
    workspaceId: decision.workspaceId,
    auth: { apiKey: decision.apiKey },
  });
  const registry = new PersistedCleanupRegistry(decision.cleanupRegistryPath);
  const outcome = await runV2WriteChain({
    clockify,
    registry,
    workspaceId: decision.workspaceId,
    adminUserId,
  });
  // The SAME construction the dry run exits on: per-case verdicts included,
  // so a case-level failure or a dropped case fails the live run itself.
  const report = buildReportFromChainOutcome({
    mode: "live",
    workspaceId: decision.workspaceId,
    outcome,
    registry,
  });
  if (!emitReport(report, outcome)) return 1;
  return report.status === "passed" ? 0 : 1;
}

/** The API key's own member identity, needed because every write re-verifies
 * the caller's CURRENT workspace role before dispatch. Read-only bookkeeping. */
async function resolveLiveAdminUserId(baseUrl: string, apiKey: string): Promise<string> {
  const res = await fetch(`${baseUrl}/user`, { headers: { "X-Api-Key": apiKey } });
  if (!res.ok) throw new Error(`live_v2_user_lookup_failed:${res.status}`);
  const body = await res.json() as { id?: string };
  if (typeof body.id !== "string" || body.id.length === 0) {
    throw new Error("live_v2_user_lookup_malformed");
  }
  return body.id;
}

async function main(): Promise<void> {
  process.exitCode = process.argv.includes("--dry-run")
    ? await runDryRunMode()
    : await runLiveMode();
}

if (process.argv[1]?.endsWith("live-v2-full.ts")) {
  main().catch((error: unknown) => {
    // Never a fake pass: an unexpected crash is a failed run, reported without
    // payloads (an error message could carry resource names or ids).
    process.stderr.write(
      `live_v2_full_crashed: ${error instanceof Error ? error.constructor.name : "unknown"}\n`,
    );
    process.stdout.write(`${JSON.stringify(buildLiveV2Report({ preparedWrites: 0, confirmedWrites: 0 }), null, 2)}\n`);
    process.exitCode = 1;
  });
}
