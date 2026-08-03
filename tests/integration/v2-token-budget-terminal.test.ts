import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAssistantV2 } from "../../src/assistant-v2/runner.js";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import { V2_LIMITS } from "../../src/assistant-v2/budgets.js";
import { createRunEventService } from "../../src/services/run-event-service.js";
import { createRunEventViewService } from "../../src/services/run-event-view-service.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import { createStore } from "../../src/db/store.js";
import { asTerminalReason, copyFor } from "../../src/assistant-v2/terminal-reason.js";

/**
 * Running out of TOKEN budget is not a provider failure.
 *
 * `preflightModelRequest` refuses the call before any fetch, and `callModel`
 * signalled that with a bare `new Error("token_budget_exhausted")`. The runner's
 * catch cannot distinguish that from a real provider fault, so it reported
 * `model_failed` — whose admin copy is "I could not reach the assistant model"
 * — for a run in which the model was never contacted. `budget_exhausted`
 * already exists as a public reason and says the true thing.
 */

const NOW = new Date("2026-06-06T12:00:00.000Z");
const directories: string[] = [];
const stores: ReturnType<typeof createStore>[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "v2-token-budget-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("token budget exhaustion is reported truthfully", () => {
  it("fails as budget_exhausted WITHOUT calling the provider", async () => {
    const store = createStore(databasePath(), { encryptionKey: "k", now: () => NOW });
    stores.push(store);
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const scope = {
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon" as const,
    };
    const runId = "run-token-budget";
    const request = "list my projects";
    store.startRunWithTurn({
      scope: { ...scope, runId },
      originalRequest: request,
      requestHash: computeRequestHash(request),
      catalogHash: MODEL_API_ACTION_CATALOG.hash(),
      loadedToolNames: [DISCOVERY_META_TOOL_NAME],
      intentHash: runId,
    });

    // Leave a SMALL remainder rather than zero. Zero trips the earlier
    // model-call reservation gate, which already reports `budget_exhausted`
    // correctly; the untruthful path is `preflightModelRequest`, reached only
    // when some budget remains but the serialized request does not fit in one
    // attempt's share of it.
    const state = store.getRun({ ...scope, runId })!;
    store.saveRun({
      ...state,
      budget: { ...state.budget, estimatedTokensUsed: V2_LIMITS.maxTotalTokens - 200 },
      updatedAt: NOW.toISOString(),
    });

    let providerCalls = 0;
    const outcome = await runAssistantV2({ runId, scope, originalRequest: request }, {
      modelClient: {
        supportsNativeTools: true,
        completeWithTools: async () => {
          providerCalls += 1;
          throw new Error("the provider must never be reached once the budget is spent");
        },
      } as never,
      runStore: store,
      eventService: createRunEventService(store),
      eventViews: createRunEventViewService(store, { sessionSecret: "s", now: () => NOW }),
      actionRegistry: MODEL_API_ACTION_CATALOG,
      discovery: { search: async () => ({ kind: "notice" as const, code: "no_available_operation_for_auth_class" as const, authClass: "addon" as const }) },
      reads: { execute: async () => { throw new Error("no reads expected"); } } as never,
      preparations: { prepare: async () => { throw new Error("no writes expected"); } } as never,
      installationGuard: { assertCurrent: () => undefined },
      requestGovernor: { runRead: async (_s: unknown, op: () => Promise<unknown>) => op() } as never,
      clock: { now: () => NOW, monotonicMs: () => 0 },
    });

    expect(providerCalls).toBe(0);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.code).toBe("budget_exhausted");

    // The admin sentence must not blame the provider, and must not leak the
    // internal sentinel.
    const copy = copyFor(asTerminalReason(outcome.code));
    expect(copy).not.toContain("token_budget_exhausted");
    expect(copy).not.toMatch(/could not reach the assistant model/i);

    // Durable: the run is terminal with the same bounded code.
    expect(store.getRun({ ...scope, runId })?.phase).toBe("failed");
  });
});
