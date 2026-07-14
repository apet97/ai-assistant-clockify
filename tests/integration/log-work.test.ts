import { describe, expect, it } from "vitest";
import { executeAction } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/catalog.js";

function makeContext(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => new Date("2026-06-05T00:00:00.000Z"),
    timeZone: "UTC",
    weekStartsOn: 1,
  };
}

function lastEntry(fake: FakeWorkspace) {
  const entries = fake.state.timeEntries;
  return entries[entries.length - 1];
}

describe("clockify_log_work time resolution (no explicit start)", () => {
  it("anchors the default 09:00 in the verified admin timezone", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_log_work",
      args: { durationHours: 2, date: "2026-06-04" },
      context: { ...makeContext(fake), timeZone: "Europe/Belgrade", weekStartsOn: 1 },
    });

    expect(result.kind).toBe("receipt");
    expect(lastEntry(fake).start).toBe("2026-06-04T07:00:00.000Z");
    expect(lastEntry(fake).end).toBe("2026-06-04T09:00:00.000Z");
  });

  it("logs a duration on a given date by anchoring a deterministic start + computed end", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_log_work",
      args: { description: "deep work", durationHours: 2, date: "2026-06-04" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (!(result.kind === "receipt" && result.receipt.ok)) throw new Error("expected a success receipt");
    const entry = lastEntry(fake);
    expect(entry.start).toBe("2026-06-04T09:00:00.000Z");
    expect(entry.end).toBe("2026-06-04T11:00:00.000Z");
    expect(fake.counts.createTimeEntry).toBe(1);
  });

  // live-dogfood-04: "log work to Apollo from 5pm to 9am today" produced an
  // entry whose end (09:00) was BEFORE its start (17:00) — a negative-length
  // entry, committed silently (log_work is a safe write, no preview). An
  // explicit end at/*before* the start must clarify, never log a reversed span.
  it("clarifies when an explicit end is at or before the start (negative-length entry), never logs it", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Apollo" }] });
    const result = await executeAction({
      actionName: "clockify_log_work",
      args: { projectName: "Apollo", start: "2026-06-05T17:00:00.000Z", end: "2026-06-05T09:00:00.000Z" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.createTimeEntry ?? 0).toBe(0);
  });

  it("resolves a relative day word ('yesterday') against ctx.now — the model needn't know the date", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_log_work",
      args: { description: "deep work", durationHours: 2, date: "yesterday" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (!(result.kind === "receipt" && result.receipt.ok)) throw new Error("expected a success receipt");
    expect(lastEntry(fake).start).toBe("2026-06-04T09:00:00.000Z");
  });

  it("resolves a numeric dayOffset (-1 = yesterday) against ctx.now", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_log_work",
      args: { description: "deep work", durationHours: 2, dayOffset: -1 },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (!(result.kind === "receipt" && result.receipt.ok)) throw new Error("expected a success receipt");
    expect(lastEntry(fake).start).toBe("2026-06-04T09:00:00.000Z");
  });

  it("accepts durationMinutes and defaults the date to today (from ctx.now)", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_log_work",
      args: { description: "standup", durationMinutes: 30, date: "today" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (!(result.kind === "receipt" && result.receipt.ok)) throw new Error("expected a success receipt");
    const entry = lastEntry(fake);
    expect(entry.start).toBe("2026-06-05T09:00:00.000Z");
    expect(entry.end).toBe("2026-06-05T09:30:00.000Z");
  });

  it("still honors an explicit start (back-compat) and computes end from duration when end is absent", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_log_work",
      args: { description: "design", start: "2026-06-05T13:00:00.000Z", durationHours: 1 },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (!(result.kind === "receipt" && result.receipt.ok)) throw new Error("expected a success receipt");
    const entry = lastEntry(fake);
    expect(entry.start).toBe("2026-06-05T13:00:00.000Z");
    expect(entry.end).toBe("2026-06-05T14:00:00.000Z");
  });

  it("rejects input with neither a start nor a duration (and writes nothing)", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_log_work",
      args: { description: "work" },
      context: makeContext(fake),
    });
    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: false, code: "invalid_args" } });
    expect(fake.counts.createTimeEntry ?? 0).toBe(0);
  });

  it("requires one exact completed-work shape and rejects offset-less instants", async () => {
    const fake = createFakeWorkspace();
    const startOnly = await executeAction({
      actionName: "clockify_log_work",
      args: { start: "2026-06-05T13:00:00Z" },
      context: makeContext(fake),
    });
    const offsetless = await executeAction({
      actionName: "clockify_log_work",
      args: { start: "2026-06-05T13:00:00", durationHours: 1 },
      context: makeContext(fake),
    });
    const conflicting = await executeAction({
      actionName: "clockify_log_work",
      args: { start: "2026-06-05T13:00:00Z", end: "2026-06-05T14:00:00Z", durationHours: 1 },
      context: makeContext(fake),
    });

    expect(startOnly).toMatchObject({ kind: "receipt", receipt: { ok: false, code: "invalid_args" } });
    expect(offsetless.kind).toBe("clarify");
    expect(conflicting.kind).toBe("receipt");
    if (conflicting.kind === "receipt" && !conflicting.receipt.ok) {
      expect(conflicting.receipt.code).toBe("invalid_args");
    }
    expect(fake.counts.createTimeEntry ?? 0).toBe(0);
  });

  it("caps completed-work duration at 168 hours", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_log_work",
      args: { date: "2026-06-01", durationHours: 169 },
      context: makeContext(fake),
    });

    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && !result.receipt.ok) expect(result.receipt.code).toBe("invalid_args");
    expect(fake.counts.createTimeEntry ?? 0).toBe(0);
  });
});
