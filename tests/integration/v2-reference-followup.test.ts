import { describe, expect, it } from "vitest";
import { getAction } from "../../src/harness/catalog.js";
import { resolveEntityReference } from "../../src/assistant-v2/references/entity-reference.js";
import { createFakeWorkspace, type FakeWorkspaceSeed } from "../helpers/fake-clockify.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import type { ActionContext } from "../../src/harness/action.js";
import type { EntityReferenceRecord } from "../../src/db/store/entity-references.js";

const NOW = new Date("2026-07-26T00:00:00.000Z");

function referenceFixture(overrides: Partial<EntityReferenceRecord>): EntityReferenceRecord {
  return {
    id: "ref-1",
    sessionId: "session-1",
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    entityType: "unset",
    externalId: "unset",
    displayName: "unset",
    bindings: [],
    bindingFingerprint: "a".repeat(64),
    sourceRunId: "run-1",
    status: "active",
    verifiedAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function contextFor(seed: FakeWorkspaceSeed): { ctx: ActionContext } {
  const fake = createFakeWorkspace(seed);
  return {
    ctx: {
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      policy: defaultAdminPolicy(),
      clockify: fake.client,
      now: () => NOW,
    },
  };
}

interface DomainRow {
  domain: string;
  actionName: string;
  seed: FakeWorkspaceSeed;
  reference: Partial<EntityReferenceRecord>;
  followUpArgs: Record<string, unknown>;
  expectedTargetId: string;
}

const ROWS: DomainRow[] = [
  {
    domain: "project",
    actionName: "clockify_projects_delete_archived",
    seed: { projects: [{ id: "project-1", name: "Marketing Site", archived: true }] },
    reference: { entityType: "project", externalId: "project-1", displayName: "Marketing Site" },
    followUpArgs: { referenceId: "ref-1" },
    expectedTargetId: "project-1",
  },
  {
    domain: "client",
    actionName: "clockify_clients_delete_archived",
    seed: { clients: [{ id: "client-1", name: "Acme Co", archived: true }] },
    reference: { entityType: "client", externalId: "client-1", displayName: "Acme Co" },
    followUpArgs: { referenceId: "ref-1" },
    expectedTargetId: "client-1",
  },
  {
    domain: "task",
    actionName: "clockify_tasks_delete_completed",
    seed: {
      projects: [{ id: "project-1", name: "Marketing Site", archived: false }],
      tasks: [{ id: "task-1", name: "Fix bug", projectId: "project-1", status: "DONE" } as never],
    },
    reference: {
      entityType: "task",
      externalId: "task-1",
      displayName: "Fix bug",
      bindings: [{ field: "scope.projectId", value: "project-1" }],
    },
    followUpArgs: { referenceId: "ref-1" },
    expectedTargetId: "task-1",
  },
  {
    domain: "tag",
    actionName: "clockify_tags_delete",
    seed: { tags: [{ id: "tag-1", name: "urgent" }] },
    reference: { entityType: "tag", externalId: "tag-1", displayName: "urgent" },
    followUpArgs: { referenceId: "ref-1" },
    expectedTargetId: "tag-1",
  },
  {
    domain: "user",
    actionName: "clockify_users_deactivate",
    seed: { users: [{ id: "user-1", name: "Bob", status: "ACTIVE" }] },
    reference: { entityType: "user", externalId: "user-1", displayName: "Bob" },
    followUpArgs: { referenceId: "ref-1" },
    expectedTargetId: "user-1",
  },
  {
    domain: "invoice",
    actionName: "clockify_invoices_delete",
    seed: { invoices: [{ id: "invoice-1", number: "INV-1", currency: "USD", status: "UNSENT", items: [] }] },
    reference: { entityType: "invoice", externalId: "invoice-1", displayName: "INV-1" },
    followUpArgs: { referenceId: "ref-1" },
    expectedTargetId: "invoice-1",
  },
  {
    domain: "expense",
    actionName: "clockify_expenses_delete",
    seed: {
      expenses: [{
        id: "expense-1", name: "Taxi", notes: "Taxi", userId: "admin-1", categoryId: "cat-1",
        date: "2026-07-14", total: 2_000, quantity: 1,
      }],
    },
    reference: { entityType: "expense", externalId: "expense-1", displayName: "Taxi" },
    followUpArgs: { referenceId: "ref-1" },
    expectedTargetId: "expense-1",
  },
];

describe("v2 generic reference follow-up (7 registered domains)", () => {
  it.each(ROWS)(
    "resolves a $domain follow-up through metadata + fixture only, with no route/pipeline branch",
    async (row) => {
      const action = getAction(row.actionName);
      if (!action) throw new Error(`${row.actionName} fixture missing from catalog`);
      if (!action.referenceSelector) throw new Error(`${row.actionName} has no referenceSelector attached`);

      const reference = referenceFixture(row.reference);
      const resolved = resolveEntityReference({
        rawArgs: row.followUpArgs,
        selector: action.referenceSelector,
        lookup: (entityType, referenceId) =>
          entityType === reference.entityType && referenceId === reference.id ? reference : undefined,
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.args).not.toHaveProperty("referenceId");

      const parsed = action.schema.safeParse(resolved.args);
      expect(parsed.success).toBe(true);

      const { ctx } = contextFor(row.seed);
      if (typeof action.handler !== "function") throw new Error(`${row.actionName} has no handler`);
      const outcome = await action.handler(ctx, resolved.args);
      expect(outcome.kind).toBe("preview");
      if (outcome.kind !== "preview") return;
      expect(outcome.preview.targets.some((target) => target.id === row.expectedTargetId)).toBe(true);
    },
  );

  it("binds both the task id and its parent project id (not externalId alone)", () => {
    const action = getAction("clockify_tasks_delete_completed");
    if (!action?.referenceSelector) throw new Error("clockify_tasks_delete_completed reference metadata missing");
    expect(action.referenceSelector.bindings).toEqual([
      { referenceField: "externalId", argumentPath: "/id" },
      { referenceField: "scope.projectId", argumentPath: "/projectId" },
    ]);
  });

  it("rejects the follow-up when the reference resolves an entityType the action does not expect", () => {
    const action = getAction("clockify_tags_delete");
    if (!action?.referenceSelector) throw new Error("clockify_tags_delete reference metadata missing");
    const wrongTypeReference = referenceFixture({ entityType: "project", externalId: "project-1" });
    const resolved = resolveEntityReference({
      rawArgs: { referenceId: "ref-1" },
      selector: action.referenceSelector,
      lookup: () => wrongTypeReference,
    });
    expect(resolved).toEqual({ ok: false, code: "reference_wrong_entity_type" });
  });

  it("requires only metadata + fixture registration — a domain with no referenceSelector has none, not a route difference", () => {
    // clockify_tags_create is api-exposed like clockify_tags_delete but was never
    // given reviewed reference bindings — proves attaching referenceSelector is a
    // per-action metadata decision, not something the resolver/route infers.
    const action = getAction("clockify_tags_create");
    expect(action?.referenceSelector).toBeUndefined();
  });
});
