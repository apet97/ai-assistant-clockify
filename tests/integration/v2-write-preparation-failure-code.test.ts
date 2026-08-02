import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import { createOperationPreparationService } from "../../src/services/operation-preparation-service.js";
import { createResultViewService } from "../../src/services/result-view-service.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { createStore } from "../../src/db/store.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { SESSION_SECRET, WRITE_PARITY_NOW } from "../helpers/v2-write-parity.js";

/**
 * The SIXTH `error.message` site, found by the sweep this branch's fifth-site
 * fix required — and the only one of the six that is ADMIN-VISIBLE by the
 * shortest path.
 *
 * `operation-preparation-service.ts` caught anything thrown by `prepareBatch`
 * and used the raw message as BOTH the receipt `code` and the receipt
 * `message`. That receipt is a canonical `action_results` row, and
 * `result-view-service.ts:113-124` renders an `ok:false` receipt by putting
 * `receipt.message` in the card SUMMARY and `receipt.code` in a card WARNING.
 * So a raw thrown string — from a store transaction running raw SQL, or from
 * any handler bug below it — reached an admin's result card verbatim.
 *
 * The allowlist immediately below the catch was never the guard: it chose
 * between two RETURN shapes, and the receipt was already built from the raw
 * value before it ran.
 */

const directories: string[] = [];
const stores: ReturnType<typeof createStore>[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "v2-prep-failure-code-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const RUN_ID = "run-prep-failure";
const HOSTILE = 'SQLITE_CONSTRAINT: UNIQUE constraint failed: operation_runs.id — payload {"name":"acme payroll"}';

function harness() {
  const fake = createFakeWorkspace();
  const store = createStore(databasePath(), { encryptionKey: "k", now: () => WRITE_PARITY_NOW });
  stores.push(store);
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "u1", addonToken: "token" });
  const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
  const scope = {
    sessionId: session.id,
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    installationGeneration: 1,
    authClass: "addon" as const,
    runId: RUN_ID,
  };
  store.startRunWithTurn({
    scope,
    originalRequest: "create a project named acme payroll",
    requestHash: computeRequestHash("create a project named acme payroll"),
    catalogHash: MODEL_API_ACTION_CATALOG.hash(),
    loadedToolNames: [DISCOVERY_META_TOOL_NAME, "clockify_projects_create"],
    intentHash: RUN_ID,
  });
  const preparations = createOperationPreparationService({
    store,
    registry: MODEL_API_ACTION_CATALOG,
    sessionSecret: SESSION_SECRET,
    clockifyForScope: () => fake.client,
    now: () => WRITE_PARITY_NOW,
    loadCalendarContext: async () => ({ timeZone: "UTC", weekStartsOn: 1 }),
  });
  const results = createResultViewService({ registry: MODEL_API_ACTION_CATALOG });
  return { store, scope, preparations, results };
}

const CALL = [{ id: "call-1", name: "clockify_projects_create", arguments: { name: "acme payroll" } }];

describe("a failed write preparation reports a bounded code", () => {
  it("never puts the thrown message on the admin's result card", async () => {
    const { store, scope, preparations, results } = harness();
    vi.spyOn(store, "prepareAssistantWriteBatchWithEvents").mockImplementation(() => {
      throw new Error(HOSTILE);
    });

    const outcome = await preparations.prepare(CALL, scope);

    expect(outcome.kind).toBe("not_ready");
    if (outcome.kind === "prepared" || outcome.kind === "clarification") throw new Error("expected a failure outcome");
    expect(outcome.code).toBe("write_port_not_ready");

    // The canonical stored result, rendered exactly as the terminal card does.
    const resultId = outcome.actionResultId;
    if (!resultId) throw new Error("expected a canonical action result");
    const stored = store.getActionResult(resultId);
    const card = results.presentActionResult("clockify_projects_create", resultId, stored);
    expect(card.presentation.status).toBe("failed");
    expect(card.presentation.summary).not.toContain("SQLITE_CONSTRAINT");
    expect(card.presentation.summary).not.toContain("acme payroll");
    expect(card.presentation.warnings.map((w) => w.code)).not.toContain(HOSTILE);
    expect(JSON.stringify(card.presentation)).not.toContain("SQLITE_CONSTRAINT");
  });

  it("still passes through the reviewed denial codes unchanged", async () => {
    const { store, scope, preparations } = harness();
    vi.spyOn(store, "prepareAssistantWriteBatchWithEvents").mockImplementation(() => {
      throw new Error("policy_denied");
    });

    const outcome = await preparations.prepare(CALL, scope);

    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") throw new Error("expected a denial");
    expect(outcome.code).toBe("policy_denied");
  });
});
