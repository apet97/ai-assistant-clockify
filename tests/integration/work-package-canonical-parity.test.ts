import { describe, expect, it } from "vitest";
import { executeAction } from "../../src/harness/actions.js";
import { getAction } from "../../src/harness/catalog.js";
import type { ActionContext } from "../../src/harness/action.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";

describe("create_work_package canonical safe-write parity", () => {
  it("covers the complete create/reuse/timer behavior without a shadow handler", async () => {
    const fake = createFakeWorkspace({
      tags: [{ id: "tag-existing", name: "Deep Work" }],
    });
    const context: ActionContext = {
      workspaceId: "workspace",
      adminUserId: "admin",
      policy: defaultAdminPolicy(),
      clockify: fake.client,
      now: () => new Date("2026-07-18T09:00:00.000Z"),
    };

    const action = getAction("clockify_create_work_package")!;
    expect(action.kind).toBe("safe_write");
    expect(action.handler).toBeUndefined();

    const result = await executeAction({
      actionName: action.name,
      args: {
        tagName: "Deep Work",
        client: { name: "Acme" },
        project: { name: "Apollo", clientName: "Acme" },
        taskName: "Build",
        startTimer: { description: "kickoff", billable: true },
      },
      context,
    });

    if (result.kind !== "receipt" || !result.receipt.ok) {
      throw new Error(`expected successful work package: ${JSON.stringify(result)}`);
    }
    expect(result.receipt.changed?.reused).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tag", id: "tag-existing" }),
    ]));
    expect(result.receipt.changed?.created).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "client" }),
      expect.objectContaining({ type: "project" }),
      expect.objectContaining({ type: "task" }),
      expect.objectContaining({ type: "time_entry" }),
    ]));
    expect(fake.counts.createClientBaseAtomic).toBe(1);
    expect(fake.counts.createProjectAtomic).toBe(1);
    expect(fake.counts.createTaskAtomic).toBe(1);
    expect(fake.counts.startTimeEntryAtomic).toBe(1);
    expect(fake.counts.createProject ?? 0).toBe(0);
    expect(fake.counts.createTask ?? 0).toBe(0);
    expect(fake.counts.startTimeEntry ?? 0).toBe(0);
  });

  it("preserves name-based reuse without dispatching a duplicate", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "client-existing", name: "Acme" }] });
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { client: { name: "Acme" } },
      context: {
        workspaceId: "workspace",
        adminUserId: "admin",
        policy: defaultAdminPolicy(),
        clockify: fake.client,
      },
    });

    expect(result).toMatchObject({
      kind: "receipt",
      receipt: {
        ok: true,
        changed: { reused: [{ type: "client", id: "client-existing", name: "Acme" }] },
      },
    });
    expect(fake.counts.createClientBaseAtomic ?? 0).toBe(0);
    expect(fake.counts.createClient ?? 0).toBe(0);
  });

  it("keeps dependency clarification in preparation and sends no mutation", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: { tag: "Deep Work", task: "Build" },
      context: {
        workspaceId: "workspace",
        adminUserId: "admin",
        policy: defaultAdminPolicy(),
        clockify: fake.client,
      },
    });

    expect(result).toMatchObject({ kind: "clarify", message: expect.stringMatching(/need a project/i) });
    expect(Object.keys(fake.counts).filter((name) => /create|start|update|delete/i.test(name))).toEqual([]);
  });
});
