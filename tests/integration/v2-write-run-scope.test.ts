import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAssistantV2 } from "../../src/assistant-v2/runner.js";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import { createRunEventService } from "../../src/services/run-event-service.js";
import { createRunEventViewService } from "../../src/services/run-event-view-service.js";
import { createOperationPreparationService } from "../../src/services/operation-preparation-service.js";
import { createReadExecutionPort } from "../../src/assistant-v2/read-execution.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { createStore } from "../../src/db/store.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";
import { SESSION_SECRET, WRITE_PARITY_NOW } from "../helpers/v2-write-parity.js";

/**
 * The run scope the WRITE path receives.
 *
 * `OperationPreparationService.prepare` requires `scope.runId` — it loads the
 * durable run to reserve budget — but the port in `protocol.ts` declared only
 * `RunScope`, and `prepareWrites` forwarded the runner's bare scope. TypeScript
 * accepted it because method parameters are checked bivariantly, so the
 * stricter implementation was assignable to the looser interface.
 *
 * In production `scope` is built from session claims and has exactly five
 * fields (`v2-chat-pipeline.ts`), so `scope.runId` was `undefined`, `getRun`
 * matched nothing, and every assistant write threw `assistant_run_not_found` —
 * which `prepareWrites`'s bare `catch` then flattened to the opaque
 * `write_port_not_ready`.
 *
 * Every existing write-parity suite missed this because their fixtures pass a
 * scope object that CARRIES `runId` (it doubles as the run identity in the
 * harness), so the field arrived by accident. This test deliberately builds the
 * production-shaped scope and keeps the run id separate, which is the only
 * shape that reproduces the failure.
 */

const directories: string[] = [];
const stores: ReturnType<typeof createStore>[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "v2-write-run-scope-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const RUN_ID = "run-write-scope";

function harness() {
  const fake = createFakeWorkspace();
  const store = createStore(databasePath(), { encryptionKey: "k", now: () => WRITE_PARITY_NOW });
  stores.push(store);
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "u1", addonToken: "token" });
  const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });

  // EXACTLY the five fields `v2-chat-pipeline.ts` builds from session claims.
  // Deliberately NOT spread with `runId` — that accident is the bug.
  const scope = {
    sessionId: session.id,
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    installationGeneration: 1,
    authClass: "addon" as const,
  };

  store.startRunWithTurn({
    scope: { ...scope, runId: RUN_ID },
    originalRequest: "create a project named adasdsa",
    requestHash: computeRequestHash("create a project named adasdsa"),
    catalogHash: MODEL_API_ACTION_CATALOG.hash(),
    loadedToolNames: [DISCOVERY_META_TOOL_NAME, "clockify_projects_create"],
    intentHash: RUN_ID,
  });

  const eventService = createRunEventService(store);
  const eventViews = createRunEventViewService(store, { sessionSecret: SESSION_SECRET, now: () => WRITE_PARITY_NOW });
  const preparations = createOperationPreparationService({
    store,
    registry: MODEL_API_ACTION_CATALOG,
    sessionSecret: SESSION_SECRET,
    clockifyForScope: () => fake.client,
    now: () => WRITE_PARITY_NOW,
    loadCalendarContext: async () => ({ timeZone: "UTC", weekStartsOn: 1 }),
  });
  const reads = createReadExecutionPort({
    registry: MODEL_API_ACTION_CATALOG,
    store,
    clockifyForScope: () => fake.client,
    now: () => WRITE_PARITY_NOW,
  });

  return { fake, store, scope, eventService, eventViews, preparations, reads };
}

describe("v2 write preparation receives the run it belongs to", () => {
  it("prepares a preview instead of failing assistant_run_not_found", async () => {
    const { store, scope, eventService, eventViews, preparations, reads } = harness();
    const model = scriptedToolModel([
      {
        text: "",
        toolCalls: [{
          id: "call-write",
          name: "clockify_projects_create",
          arguments: { name: "adasdsa" },
        }],
      },
      { text: "Done.", toolCalls: [] },
    ]);

    const outcome = await runAssistantV2({
      runId: RUN_ID,
      scope,
      originalRequest: "create a project named adasdsa",
    }, {
      modelClient: model,
      runStore: store,
      eventService,
      eventViews,
      actionRegistry: MODEL_API_ACTION_CATALOG,
      discovery: { search: async () => ({ kind: "notice" as const, code: "no_available_operation_for_auth_class" as const, authClass: "addon" as const }) },
      reads,
      preparations,
      installationGuard: { assertCurrent: () => undefined },
      requestGovernor: {
        runRead: async (_s, op) => op(),
      },
      clock: { now: () => WRITE_PARITY_NOW, monotonicMs: () => 0 },
    });

    // Before the fix this was `completed`: preparation threw
    // `assistant_run_not_found`, the catch turned it into `write_port_not_ready`,
    // the loop carried on, and the admin was told "Completed." while nothing
    // had been prepared.
    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") throw new Error(`expected suspension, got ${outcome.kind}`);
    expect(outcome.reason).toBe("awaiting_confirmation");

    const pending = store.getPendingConfirmation(outcome.continuationId);
    expect(pending?.status).toBe("pending");
    expect(store.getOperationRun(pending!.operationId)?.status).toBe("prepared");
  });

  it("never reports the opaque write_port_not_ready for a healthy write", async () => {
    const { store, scope, eventService, eventViews, preparations, reads } = harness();
    const model = scriptedToolModel([
      {
        text: "",
        toolCalls: [{ id: "call-write", name: "clockify_projects_create", arguments: { name: "adasdsa" } }],
      },
      { text: "Done.", toolCalls: [] },
    ]);

    await runAssistantV2({ runId: RUN_ID, scope, originalRequest: "create a project named adasdsa" }, {
      modelClient: model,
      runStore: store,
      eventService,
      eventViews,
      actionRegistry: MODEL_API_ACTION_CATALOG,
      discovery: { search: async () => ({ kind: "notice" as const, code: "no_available_operation_for_auth_class" as const, authClass: "addon" as const }) },
      reads,
      preparations,
      installationGuard: { assertCurrent: () => undefined },
      requestGovernor: { runRead: async (_s, op) => op() },
      clock: { now: () => WRITE_PARITY_NOW, monotonicMs: () => 0 },
    });

    const page = eventViews.list({ scope, runId: RUN_ID, after: 0, limit: 100 });
    const journal = JSON.stringify(page.events);
    expect(journal).not.toContain("write_port_not_ready");
    expect(journal).not.toContain("assistant_run_not_found");
  });
});
