import { describe, expect, it } from "vitest";
import { executeAction } from "../../src/harness/actions.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { actionFingerprintForDefinition, getAction } from "../../src/harness/catalog.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import type { ActionContext } from "../../src/harness/action.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");

const ENTRY_READ_API_ACTIONS = [
  "clockify_entries_list",
  "clockify_entries_get",
] as const;

const ENTRY_CREATE_TIMER_API_ACTIONS = [
  "clockify_entries_create",
  "clockify_entries_start",
  "clockify_stop_timer",
] as const;

const INTERNAL_ONLY_ENTRY_READ_ACTIONS = [
  "clockify_status",
  "clockify_review_day",
  "clockify_review_week",
  "clockify_create_work_package",
] as const;

const INTERNAL_ONLY_ENTRY_MUTATION_ACTIONS = [
  "clockify_log_work",
  "clockify_start_timer",
] as const;

function makeContext(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => NOW,
    timeZone: "UTC",
    weekStartsOn: 1,
  };
}

const seedEntries = () => ({
  entries: [
    { id: "e1", description: "A", start: "2026-06-05T09:00:00Z", end: "2026-06-05T10:00:00Z" },
  ],
});

describe("v2 time entry read API actions", () => {
  it("exposes exact list/get reads on MODEL_API and hides convenience composites", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of ENTRY_READ_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
      expect(getAction(name)?.apiOperation?.operationId).toBe(
        name === "clockify_entries_list" ? "getTimeEntries" : "getTimeEntry",
      );
    }
    for (const name of INTERNAL_ONLY_ENTRY_READ_ACTIONS) {
      expect(modelNames.has(name), name).toBe(false);
      expect(getAction(name)?.apiExposure).not.toBe("api");
    }
  });

  it("clockify_entries_list resolves server dates and surfaces truncated list receipts", async () => {
    const fake = createFakeWorkspace({ ...seedEntries(), listTruncated: { getEntries: true } });
    const result = await executeAction({
      actionName: "clockify_entries_list",
      args: { start: "today", end: "today" },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected receipt");
    expect((result.receipt.data as { truncated?: boolean }).truncated).toBe(true);
    expect(result.receipt.warnings?.some((warning) => warning.code === "list_truncated")).toBe(true);
  });

  it("clockify_entries_get fetches one entry by id", async () => {
    const fake = createFakeWorkspace(seedEntries());
    const result = await executeAction({
      actionName: "clockify_entries_get",
      args: { id: "e1" },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected receipt");
    expect((result.receipt.data as { entry?: { id?: string } }).entry?.id).toBe("e1");
  });

  it("changes the catalog fingerprint when entry read presentation metadata changes", () => {
    const action = getAction("clockify_entries_list");
    if (!action) throw new Error("missing entries_list action");
    const baseline = actionFingerprintForDefinition(action);
    const altered = actionFingerprintForDefinition({
      ...action,
      presentation: { presenterId: action.presentation!.presenterId, version: action.presentation!.version + 1 },
    });
    expect(altered).not.toBe(baseline);
  });
});

describe("v2 time entry create and timer API actions", () => {
  it("exposes atomic create/start/stop actions on MODEL_API and hides generic wrappers", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of ENTRY_CREATE_TIMER_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
    expect(getAction("clockify_entries_create")?.apiOperation?.operationId).toBe("createTimeEntry");
    expect(getAction("clockify_entries_start")?.apiOperation?.operationId).toBe("createTimeEntry");
    expect(getAction("clockify_stop_timer")?.apiOperation?.operationId).toBe("stopRunningTimeEntry");
    for (const name of INTERNAL_ONLY_ENTRY_MUTATION_ACTIONS) {
      expect(modelNames.has(name), name).toBe(false);
      expect(getAction(name)?.apiExposure).toBe("generic");
    }
    expect(modelNames.has("clockify_create_work_package")).toBe(false);
  });

  it("clockify_entries_create executes with a single POST", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Apollo" }] });
    const result = await executeAction({
      actionName: "clockify_entries_create",
      args: {
        date: "today",
        durationHours: 2,
        projectName: "Apollo",
        description: "Design",
      },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected receipt");
    expect(fake.counts.createTimeEntryAtomic).toBe(1);
    expect(fake.counts.startTimeEntryAtomic ?? 0).toBe(0);
  });

  it("clockify_entries_start executes with a single POST and no prior status read", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Apollo" }] });
    const result = await executeAction({
      actionName: "clockify_entries_start",
      args: { projectName: "Apollo", description: "Timer" },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected receipt");
    expect(fake.counts.startTimeEntryAtomic).toBe(1);
    expect(fake.counts.createTimeEntryAtomic ?? 0).toBe(0);
  });

  it("clockify_stop_timer stops with a single PATCH", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Apollo" }] });
    const started = await executeAction({
      actionName: "clockify_entries_start",
      args: { description: "Running" },
      context: makeContext(fake),
    });
    if (started.kind !== "receipt" || !started.receipt.ok) throw new Error("expected start receipt");
    const result = await executeAction({
      actionName: "clockify_stop_timer",
      args: {},
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected receipt");
    expect(fake.counts.stopTimeEntryAtomic).toBe(1);
  });
});
