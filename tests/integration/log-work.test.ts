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
  };
}

function lastEntry(fake: FakeWorkspace) {
  const entries = fake.state.timeEntries;
  return entries[entries.length - 1];
}

describe("clockify_log_work time resolution (no explicit start)", () => {
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
      args: { description: "standup", durationMinutes: 30 },
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

  it("asks one precise clarification when neither a start nor a duration is given (and writes nothing)", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_log_work",
      args: { description: "work" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.createTimeEntry ?? 0).toBe(0);
  });
});
