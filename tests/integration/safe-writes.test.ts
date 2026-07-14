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

  it("start_timer resolves a project NAME to its id and starts the timer on it", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p-acme", name: "Acme Corp" }] });
    const result = await executeAction({
      actionName: "clockify_start_timer",
      args: { projectName: "Acme Corp" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && result.receipt.ok) {
      expect(fake.counts.startTimeEntry).toBe(1);
      expect(fake.state.running?.projectId).toBe("p-acme");
    } else {
      throw new Error("expected a success receipt");
    }
    expect(fake.counts.createProject ?? 0).toBe(0); // never creates a project
  });

  it("start_timer clarifies (never creates) when the project NAME does not exist", async () => {
    // The finding: a timer-start against a misspelled / non-existent project must
    // clarify like clockify_log_work — never silently create a new project.
    const fake = createFakeWorkspace({ projects: [{ id: "p-acme", name: "Acme Corp" }] });
    const result = await executeAction({
      actionName: "clockify_start_timer",
      args: { projectName: "Acme Crp" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") {
      expect(result.message).toMatch(/Acme Crp/);
    }
    expect(fake.counts.createProject ?? 0).toBe(0); // never creates the mistyped project
    expect(fake.counts.startTimeEntry ?? 0).toBe(0); // and never starts a timer on an unverified project
  });

  it("start_timer resolves a project NAME placed in the projectId SLOT (the planner habit)", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p-acme", name: "Acme Corp" }] });
    const result = await executeAction({
      actionName: "clockify_start_timer",
      args: { projectId: "Acme Corp" },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected a success receipt");
    expect(fake.state.running?.projectId).toBe("p-acme");
  });

  it("start_timer's unknown-project clarify still offers to create it first", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p-acme", name: "Acme Corp" }] });
    const result = await executeAction({
      actionName: "clockify_start_timer",
      args: { projectName: "Acme Crp" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") {
      expect(result.message).toMatch(/should I create it first/i);
      // The clarify is grounded: the near-miss is offered as an option.
      expect(result.options?.map((o) => o.id)).toContain("p-acme");
    }
  });

  it("log_work resolves a project NAME placed in the projectId SLOT", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p-acme", name: "Acme Corp" }] });
    const result = await executeAction({
      actionName: "clockify_log_work",
      args: {
        description: "design work",
        start: "2026-06-05T09:00:00.000Z",
        end: "2026-06-05T10:00:00.000Z",
        projectId: "Acme Corp",
      },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected a success receipt");
    expect(fake.state.timeEntries.at(-1)?.projectId).toBe("p-acme");
  });

  it("start_timer + log_work resolve tag NAMES (tagNames or a name inside tagIds) to verified ids", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p-acme", name: "Acme Corp" }],
      tags: [{ id: "t-deep", name: "Deep Work" }],
    });
    const started = await executeAction({
      actionName: "clockify_start_timer",
      args: { projectName: "Acme Corp", tagNames: ["Deep Work"] },
      context: makeContext(fake),
    });
    if (started.kind !== "receipt" || !started.receipt.ok) throw new Error(`expected a success receipt, got ${started.kind}`);
    expect(fake.state.running?.tagIds).toEqual(["t-deep"]);

    const logged = await executeAction({
      actionName: "clockify_log_work",
      args: {
        description: "focus",
        start: "2026-06-05T09:00:00.000Z",
        end: "2026-06-05T10:00:00.000Z",
        tagIds: ["Deep Work"], // the planner habit: a NAME in the id slot
      },
      context: makeContext(fake),
    });
    if (logged.kind !== "receipt" || !logged.receipt.ok) throw new Error(`expected a success receipt, got ${logged.kind}`);
    expect(fake.state.timeEntries.at(-1)?.tagIds).toEqual(["t-deep"]);
  });

  it("log_work works WITHOUT a description (omitted on the wire — never asked for, never invented)", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p-acme", name: "Acme Corp" }] });
    const result = await executeAction({
      actionName: "clockify_log_work",
      args: {
        projectName: "Acme Corp",
        start: "2026-06-05T09:00:00.000Z",
        end: "2026-06-05T11:00:00.000Z",
      },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error(`expected a success receipt, got ${result.kind}`);
    const entry = fake.state.timeEntries.at(-1);
    expect(entry?.projectId).toBe("p-acme");
    expect(entry?.description ?? "").toBe(""); // honest blank, not a fabricated description
  });

  it("log_work clarifies on an unknown tag and writes NOTHING", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t-deep", name: "Deep Work" }] });
    const result = await executeAction({
      actionName: "clockify_log_work",
      args: {
        description: "focus",
        start: "2026-06-05T09:00:00.000Z",
        end: "2026-06-05T10:00:00.000Z",
        tagNames: ["Deep Wrk"],
      },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") expect(result.options?.map((o) => o.id)).toContain("t-deep");
    expect(fake.counts.createTimeEntry ?? 0).toBe(0);
  });

  it("stop_timer with no running timer is a truthful no-op: success WITH the warning, nothing changed", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_stop_timer",
      args: {},
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected a success receipt");
    expect(result.receipt.warnings).toEqual([{ message: "No running timer to stop." }]);
    expect(result.receipt.changed).toBeUndefined();
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

  it("create_work_package accepts a flat projectName (the planner's natural shape) and starts the timer", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { projectName: "Apollo", startTimer: true },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && result.receipt.ok) {
      const projectRef = (result.receipt.changed?.created ?? []).find((e) => e.type === "project");
      expect(projectRef).toBeDefined();
      expect(fake.counts.createProject).toBe(1);
      expect(fake.counts.startTimeEntry).toBe(1);
      expect(fake.state.running?.projectId).toBe(projectRef?.id);
    } else {
      throw new Error("expected a success receipt");
    }
  });

  it("create_work_package accepts a bare-string project / tagName alias", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { project: "Apollo", tagName: "Deep Work" },
      context: makeContext(fake),
    });
    if (result.kind === "receipt" && result.receipt.ok) {
      const created = result.receipt.changed?.created ?? [];
      expect(created.some((e) => e.type === "project")).toBe(true);
      expect(created.some((e) => e.type === "tag")).toBe(true);
    } else {
      throw new Error("expected a success receipt");
    }
  });

  it("create_work_package accepts startTimer as a bare boolean (the planner's natural shape)", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { project: { name: "Apollo" }, startTimer: true },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && result.receipt.ok) {
      const projectRef = (result.receipt.changed?.created ?? []).find((e) => e.type === "project");
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
      args: { description: "design work", start: "2026-06-05T09:00:00.000Z", durationHours: 1, projectName: "Website" },
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

  it("status resolves the running entry's projectId to a human-readable projectName", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "proj-acme", name: "Acme Corp" }],
      running: {
        id: "e-run",
        description: "Daily work",
        projectId: "proj-acme",
        start: "2026-06-12T09:00:00.000Z",
      },
    });
    const result = await executeAction({
      actionName: "clockify_status",
      args: {},
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected a success receipt");
    const data = result.receipt.data as { running: { projectId?: string; projectName?: string } | null };
    expect(data.running).not.toBeNull();
    // The receipt must carry the resolved name so the model never has to leak the raw id.
    expect(data.running?.projectName).toBe("Acme Corp");
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

  it("review_day flags a truncated entry list (the total is understated) with a list_truncated warning", async () => {
    // A truncated list means totalMinutes is computed on an incomplete set — the
    // caveat must say the total is understated, not just that rows are missing.
    const fake = createFakeWorkspace({
      entriesTruncated: true,
      entries: [{ id: "in1", start: "2026-06-05T09:00:00.000Z", end: "2026-06-05T10:00:00.000Z", description: "a" }],
    });
    const result = await executeAction({
      actionName: "clockify_review_day",
      args: { date: "2026-06-05" },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected a success receipt");
    expect((result.receipt.data as any).truncated).toBe(true);
    expect(result.receipt.warnings?.map((w) => w.code)).toContain("list_truncated");
    expect(result.receipt.warnings?.[0].message.toLowerCase()).toContain("understated");
  });

  it("review_week flags a truncated entry list with a list_truncated warning", async () => {
    const fake = createFakeWorkspace({
      entriesTruncated: true,
      entries: [{ id: "w1", start: "2026-06-01T09:00:00.000Z", description: "a" }],
    });
    const result = await executeAction({
      actionName: "clockify_review_week",
      args: { start: "2026-06-01" },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected a success receipt");
    expect((result.receipt.data as any).truncated).toBe(true);
    expect(result.receipt.warnings?.map((w) => w.code)).toContain("list_truncated");
  });

  it("review_day emits no truncation caveat on a complete list", async () => {
    const fake = createFakeWorkspace({
      entries: [{ id: "in1", start: "2026-06-05T09:00:00.000Z", end: "2026-06-05T10:00:00.000Z", description: "a" }],
    });
    const result = await executeAction({
      actionName: "clockify_review_day",
      args: { date: "2026-06-05" },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected a success receipt");
    expect((result.receipt.data as any).truncated).toBeUndefined();
    expect(result.receipt.warnings).toBeUndefined();
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

  it("review_day resolves a RELATIVE date server-side (live: ?start=today reached the wire)", async () => {
    // makeContext's clock is 2026-06-05.
    const fake = createFakeWorkspace({
      entries: [
        { id: "in1", start: "2026-06-05T09:00:00.000Z", end: "2026-06-05T10:00:00.000Z", description: "a" },
        { id: "out", start: "2026-06-04T09:00:00.000Z", end: "2026-06-04T10:00:00.000Z", description: "b" },
      ],
    });
    const result = await executeAction({
      actionName: "clockify_review_day",
      args: { date: "today" },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected a success receipt");
    expect((result.receipt.data as { count: number }).count).toBe(1);
  });

  it("review_day resolves a user NAME (or 'me') in the userId slot to the real member", async () => {
    const fake = createFakeWorkspace({
      users: [{ id: "u-ana", name: "Ana" }],
      entries: [
        { id: "a1", start: "2026-06-05T09:00:00.000Z", end: "2026-06-05T10:00:00.000Z", description: "ana" },
      ],
    });
    const byName = await executeAction({
      actionName: "clockify_review_day",
      args: { date: "2026-06-05", userId: "Ana" },
      context: makeContext(fake),
    });
    if (byName.kind !== "receipt" || !byName.receipt.ok) throw new Error("expected a success receipt");
    expect((byName.receipt.data as { userId: string }).userId).toBe("u-ana");

    const me = await executeAction({
      actionName: "clockify_review_day",
      args: { date: "2026-06-05", userId: "me" },
      context: makeContext(fake),
    });
    if (me.kind !== "receipt" || !me.receipt.ok) throw new Error("expected a success receipt");
    expect((me.receipt.data as { userId: string }).userId).toBe("admin-1");
  });

  it("review_day clarifies on an unknown user instead of a doomed wire call", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "u-ana", name: "Ana" }] });
    const result = await executeAction({
      actionName: "clockify_review_day",
      args: { date: "2026-06-05", userId: "Anna B" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") expect(result.options?.map((o) => o.id)).toContain("u-ana");
    expect(fake.counts.getEntries ?? 0).toBe(0);
  });

  it("review_week resolves a user NAME in the userId slot", async () => {
    const fake = createFakeWorkspace({
      users: [{ id: "u-ana", name: "Ana" }],
      entries: [{ id: "a1", start: "2026-06-05T09:00:00.000Z", description: "ana" }],
    });
    const result = await executeAction({
      actionName: "clockify_review_week",
      args: { start: "2026-06-01", userId: "Ana" },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected a success receipt");
    expect((result.receipt.data as { userId: string }).userId).toBe("u-ana");
  });

  it("review_day CLARIFIES on an unparseable date (live: it crashed with 'Invalid time value')", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_review_day",
      args: { date: "banana" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
  });

  it("review_week resolves a relative start and CLARIFIES on garbage instead of throwing", async () => {
    // 2026-06-05 is a Friday → "last monday" = 2026-06-01.
    const fake = createFakeWorkspace({
      entries: [
        { id: "w1", start: "2026-06-01T09:00:00.000Z", description: "a" },
        { id: "w2", start: "2026-06-07T23:00:00.000Z", description: "b" },
        { id: "later", start: "2026-06-08T09:00:00.000Z", description: "c" },
      ],
    });
    const resolved = await executeAction({
      actionName: "clockify_review_week",
      args: { start: "last monday" },
      context: makeContext(fake),
    });
    if (resolved.kind !== "receipt" || !resolved.receipt.ok) throw new Error("expected a success receipt");
    expect((resolved.receipt.data as { count: number }).count).toBe(2);

    const garbage = await executeAction({
      actionName: "clockify_review_week",
      args: { start: "whenever" },
      context: makeContext(fake),
    });
    expect(garbage.kind).toBe("clarify");
  });

  // clockify_fix_entry was reclassified safe_write -> high_risk_write: editing an
  // existing time entry now previews + requires confirmation (it was the lone
  // safe_write update outlier, and edits have no undo). Its full coverage —
  // preview→commit, billable flip, project/task name resolution at preview,
  // name-in-id-slot, clarify-on-unknown, and the policy gate — moved to
  // risky-preview.test.ts where the other update actions live.

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
