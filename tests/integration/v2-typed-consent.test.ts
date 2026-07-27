import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { createStore } from "../../src/db/store.js";
import { createOperationPreparationService } from "../../src/services/operation-preparation-service.js";
import { createConfirmationService } from "../../src/services/confirmation-service.js";
import { createWorkspaceMutationCoordinator } from "../../src/clockify/workspace-mutation-coordinator.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { mutationCallTotal, SESSION_SECRET, WRITE_PARITY_NOW } from "../helpers/v2-write-parity.js";

const directories: string[] = [];
const stores: ReturnType<typeof createStore>[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "v2-typed-consent-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function harness() {
  const fake = createFakeWorkspace({});
  const store = createStore(databasePath(), { encryptionKey: "k", now: () => WRITE_PARITY_NOW });
  stores.push(store);
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "u1", addonToken: "token" });
  const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
  const scope = {
    sessionId: session.id,
    runId: "run-1",
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    installationGeneration: 1,
    authClass: "addon" as const,
  };
  store.startRunWithTurn({
    scope,
    originalRequest: "create a tag named Preview Tag",
    requestHash: computeRequestHash("create a tag named Preview Tag"),
    catalogHash: MODEL_API_ACTION_CATALOG.hash(),
    loadedToolNames: ["clockify_tags_create"],
    intentHash: scope.runId,
  });
  const preparation = createOperationPreparationService({
    store,
    registry: MODEL_API_ACTION_CATALOG,
    sessionSecret: SESSION_SECRET,
    clockifyForScope: () => fake.client,
    now: () => WRITE_PARITY_NOW,
    loadCalendarContext: async () => ({ timeZone: "UTC", weekStartsOn: 1 }),
  });
  const confirmation = createConfirmationService({
    store,
    registry: MODEL_API_ACTION_CATALOG,
    sessionSecret: SESSION_SECRET,
    catalogHash: () => MODEL_API_ACTION_CATALOG.hash(),
    now: () => WRITE_PARITY_NOW,
    loadPolicy: () => defaultAdminPolicy(),
    verifyWriteAuthority: async () => ({ ok: true as const, installationGeneration: 1 }),
    actionContext: () => ({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      policy: defaultAdminPolicy(),
      clockify: fake.client,
      now: () => WRITE_PARITY_NOW,
    }),
    mutationCoordinator: createWorkspaceMutationCoordinator(),
    recordUndoIfReversible: () => undefined,
  });
  return { fake, store, session, scope, preparation, confirmation };
}

const TYPED_CONSENT_INPUTS: Array<{ label: string; value: string }> = [
  { label: "yes", value: "yes" },
  { label: "Yes", value: "Yes" },
  { label: "YES", value: "YES" },
  { label: "confirm", value: "confirm" },
  { label: "do it", value: "do it" },
  { label: "exact copied button label", value: "Confirm" },
  { label: "leading whitespace", value: "  yes" },
  { label: "trailing whitespace", value: "yes  " },
  { label: "leading+trailing whitespace", value: "  yes  " },
  { label: "Cyrillic lookalike уes (Cyrillic у)", value: "уes" },
  { label: "full-width yes", value: "ｙｅｓ" },
  { label: "empty string", value: "" },
];

describe("v2 typed consent never confirms a mutation", () => {
  it.each(TYPED_CONSENT_INPUTS)("rejects typed input as a nonce: $label", async ({ value }) => {
    const { fake, store, session, scope, preparation, confirmation } = harness();
    const before = mutationCallTotal(fake.counts);

    const prepared = await preparation.prepare(
      [{ id: "tool-1", name: "clockify_tags_create", arguments: { name: "Preview Tag" } }],
      scope,
    );
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") throw new Error("prepare failed");
    const confirmationId = prepared.confirmationIds[0]!;

    const outcome = await confirmation.confirmSingle({
      claims: { sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1" },
      record: store.getPendingConfirmation(confirmationId)!,
      nonce: value,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("typed consent must never confirm");
    expect(outcome.body.code).toBe("invalid_confirmation");
    expect(mutationCallTotal(fake.counts) - before).toBe(0);

    const pending = store.getPendingConfirmation(confirmationId)!;
    expect(pending.status).toBe("pending");
  });
});
