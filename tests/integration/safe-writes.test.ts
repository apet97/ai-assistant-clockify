import { describe, expect, it } from "vitest";
import { executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/catalog.js";

function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy,
    clockify: fake.client,
    now: () => new Date("2026-06-05T00:00:00.000Z"),
  };
}

describe("safe writes", () => {
  it("unknown action returns an error receipt", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "definitely_not_an_action",
      args: {},
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.ok).toBe(false);
      if (!result.receipt.ok) expect(result.receipt.code).toBe("unknown_action");
    }
  });

  it("a safe write executes without confirmation, calls Clockify once, and returns a changed receipt", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_start_timer",
      args: { description: "Deep Work" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && result.receipt.ok) {
      expect(result.receipt.changed?.created).toHaveLength(1);
      expect(result.receipt.changed?.created?.[0].type).toBe("time_entry");
    } else {
      throw new Error("expected a success receipt");
    }
    expect(fake.counts.startTimeEntry).toBe(1);
  });

  it("create_work_package creates new entities and reuses existing ones", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "client-existing", name: "Acme" }] });
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { tag: { name: "Deep Work" }, client: { name: "Acme" } },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && result.receipt.ok) {
      const created = result.receipt.changed?.created ?? [];
      const reused = result.receipt.changed?.reused ?? [];
      expect(created.some((e) => e.type === "tag")).toBe(true);
      expect(reused.some((e) => e.type === "client" && e.id === "client-existing")).toBe(true);
    } else {
      throw new Error("expected a success receipt");
    }
    expect(fake.counts.createClient ?? 0).toBe(0); // reused, not created
  });

  it("create_work_package with startTimer creates the project and starts a timer carrying its id", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { project: { name: "Apollo" }, startTimer: { description: "kickoff" } },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && result.receipt.ok) {
      const created = result.receipt.changed?.created ?? [];
      const projectRef = created.find((e) => e.type === "project");
      expect(projectRef).toBeDefined();
      expect(created.some((e) => e.type === "time_entry")).toBe(true);
      // The timer must carry the just-created project's id (resolved server-side).
      expect(fake.counts.startTimeEntry).toBe(1);
      expect(fake.state.running?.projectId).toBe(projectRef?.id);
    } else {
      throw new Error("expected a success receipt");
    }
  });

  it("create_work_package with startTimer reuses an existing project and starts the timer on it", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p-acme", name: "Acme" }] });
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { project: { name: "Acme" }, startTimer: {} },
      context: makeContext(fake),
    });
    if (result.kind === "receipt" && result.receipt.ok) {
      expect(fake.counts.createProject ?? 0).toBe(0); // reused, not created
      expect(fake.counts.startTimeEntry).toBe(1);
      expect(fake.state.running?.projectId).toBe("p-acme");
    } else {
      throw new Error("expected a success receipt");
    }
  });

  it("create_work_package with startTimer but no project asks to clarify and starts nothing", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { tag: { name: "Deep Work" }, startTimer: {} },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.startTimeEntry ?? 0).toBe(0);
  });

  it("create_work_package with startTimer skips the timer (with a warning) when time_tracking is read-only", async () => {
    const fake = createFakeWorkspace();
    const policy = defaultAdminPolicy();
    policy.groups.time_tracking = "read";
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { project: { name: "Apollo" }, startTimer: {} },
      context: makeContext(fake, policy),
    });
    if (result.kind === "receipt" && result.receipt.ok) {
      expect(fake.counts.createProject).toBe(1); // project still created (work_structure allowed)
      expect(fake.counts.startTimeEntry ?? 0).toBe(0); // timer skipped
      expect((result.receipt.warnings ?? []).some((w) => /timer/i.test(w.message))).toBe(true);
    } else {
      throw new Error("expected a success receipt");
    }
  });

  it("an ambiguous write target asks a clarifying question and does not write", async () => {
    const fake = createFakeWorkspace({
      projects: [
        { id: "p1", name: "Website" },
        { id: "p2", name: "Website" },
      ],
    });
    const result = await executeAction({
      actionName: "clockify_log_work",
      args: { description: "design work", start: "2026-06-05T09:00:00.000Z", projectName: "Website" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") expect(result.options?.length).toBe(2);
    expect(fake.counts.createTimeEntry ?? 0).toBe(0);
  });

  it("a write is blocked when the feature group is read-only", async () => {
    const fake = createFakeWorkspace();
    const policy = defaultAdminPolicy();
    policy.groups.time_tracking = "read";
    const result = await executeAction({
      actionName: "clockify_start_timer",
      args: {},
      context: makeContext(fake, policy),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.ok).toBe(false);
      if (!result.receipt.ok) expect(result.receipt.code).toBe("policy_denied");
    }
    expect(fake.counts.startTimeEntry ?? 0).toBe(0);
  });

  it("a read is allowed under a read policy but blocked under off", async () => {
    const readPolicy = defaultAdminPolicy();
    readPolicy.groups.time_tracking = "read";
    const readResult = await executeAction({
      actionName: "clockify_status",
      args: {},
      context: makeContext(createFakeWorkspace(), readPolicy),
    });
    expect(readResult.kind === "receipt" && readResult.receipt.ok).toBe(true);

    const offPolicy = defaultAdminPolicy();
    offPolicy.groups.time_tracking = "off";
    const offResult = await executeAction({
      actionName: "clockify_status",
      args: {},
      context: makeContext(createFakeWorkspace(), offPolicy),
    });
    expect(offResult.kind === "receipt" && !offResult.receipt.ok).toBe(true);
  });
});

describe("expanded read + safe-write actions (Phase 3)", () => {
  it("review_day summarizes only that day's entries", async () => {
    const fake = createFakeWorkspace({
      entries: [
        { id: "in1", start: "2026-06-05T09:00:00.000Z", end: "2026-06-05T10:00:00.000Z", description: "a" },
        { id: "in2", start: "2026-06-05T11:00:00.000Z", end: "2026-06-05T12:00:00.000Z", description: "b" },
        { id: "out", start: "2026-06-06T09:00:00.000Z", end: "2026-06-06T10:00:00.000Z", description: "c" },
      ],
    });
    const result = await executeAction({
      actionName: "clockify_review_day",
      args: { date: "2026-06-05" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && result.receipt.ok) {
      const data = result.receipt.data as { count: number; entries: unknown[] };
      expect(data.count).toBe(2);
      expect(data.entries).toHaveLength(2);
    } else {
      throw new Error("expected a success receipt");
    }
    expect(fake.counts.getEntries).toBe(1);
  });

  it("review_week summarizes the 7-day window from the given start", async () => {
    const fake = createFakeWorkspace({
      entries: [
        { id: "w1", start: "2026-06-01T09:00:00.000Z", description: "a" },
        { id: "w2", start: "2026-06-07T23:00:00.000Z", description: "b" },
        { id: "later", start: "2026-06-08T09:00:00.000Z", description: "c" },
      ],
    });
    const result = await executeAction({
      actionName: "clockify_review_week",
      args: { start: "2026-06-01" },
      context: makeContext(fake),
    });
    if (result.kind === "receipt" && result.receipt.ok) {
      const data = result.receipt.data as { count: number };
      expect(data.count).toBe(2);
    } else {
      throw new Error("expected a success receipt");
    }
  });

  it("fix_entry updates a known time entry without confirmation", async () => {
    const fake = createFakeWorkspace({
      entries: [{ id: "e1", start: "2026-06-05T09:00:00.000Z", description: "old" }],
    });
    const result = await executeAction({
      actionName: "clockify_fix_entry",
      args: { id: "e1", description: "new" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && result.receipt.ok) {
      expect(result.receipt.changed?.updated?.[0].id).toBe("e1");
    } else {
      throw new Error("expected a success receipt");
    }
    expect(fake.counts.updateTimeEntry).toBe(1);
  });

  it("fix_entry is blocked when time_tracking is read-only", async () => {
    const fake = createFakeWorkspace({ entries: [{ id: "e1", start: "x", description: "old" }] });
    const policy = defaultAdminPolicy();
    policy.groups.time_tracking = "read";
    const result = await executeAction({
      actionName: "clockify_fix_entry",
      args: { id: "e1", description: "new" },
      context: makeContext(fake, policy),
    });
    expect(result.kind === "receipt" && !(result as any).receipt.ok).toBe(true);
    expect(fake.counts.updateTimeEntry ?? 0).toBe(0);
  });

  it("list_entities lists tags as a read", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "Deep Work" }] });
    const result = await executeAction({
      actionName: "clockify_list_entities",
      args: { entityType: "tag" },
      context: makeContext(fake),
    });
    if (result.kind === "receipt" && result.receipt.ok) {
      const data = result.receipt.data as { entityType: string; items: unknown[] };
      expect(data.entityType).toBe("tag");
      expect(data.items).toHaveLength(1);
    } else {
      throw new Error("expected a success receipt");
    }
  });

  it("list_entities for tasks without a project asks to clarify", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_list_entities",
      args: { entityType: "task" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.listTasks ?? 0).toBe(0);
  });

  it("list_entities routes the policy gate to the entity's group (users blocked when off)", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "u1", name: "Ada" }] });
    const policy = defaultAdminPolicy();
    policy.groups.users_groups = "off";
    const result = await executeAction({
      actionName: "clockify_list_entities",
      args: { entityType: "user" },
      context: makeContext(fake, policy),
    });
    expect(result.kind === "receipt" && !(result as any).receipt.ok).toBe(true);
    expect(fake.counts.listUsers ?? 0).toBe(0);
  });

  it("get_entity returns the matching entity by id", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website" }] });
    const result = await executeAction({
      actionName: "clockify_get_entity",
      args: { entityType: "project", id: "p1" },
      context: makeContext(fake),
    });
    if (result.kind === "receipt" && result.receipt.ok) {
      const data = result.receipt.data as { entity: { id: string } | null };
      expect(data.entity?.id).toBe("p1");
    } else {
      throw new Error("expected a success receipt");
    }
  });

  it("show_permissions returns the caller's policy", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "assistant_show_permissions",
      args: {},
      context: makeContext(fake),
    });
    if (result.kind === "receipt" && result.receipt.ok) {
      const data = result.receipt.data as { policy: { groups: Record<string, string> } };
      expect(data.policy.groups.time_tracking).toBe("read_write");
    } else {
      throw new Error("expected a success receipt");
    }
    // Reading one's own policy makes no Clockify call.
    expect(Object.keys(fake.counts)).toHaveLength(0);
  });
});
