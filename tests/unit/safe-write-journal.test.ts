import { describe, expect, it } from "vitest";
import { executeAction } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";

describe("prepared safe writes", () => {
  it("persists normalized nonsecret wire intent before the single host dispatch", async () => {
    const fake = createFakeWorkspace();
    const events: string[] = [];
    const originalCreate = fake.client.createTag.bind(fake.client);
    fake.client.createTag = async (input) => {
      events.push("host");
      return originalCreate(input);
    };
    let prepared: unknown;
    let plan: unknown;

    const result = await executeAction({
      actionName: "clockify_tags_create",
      args: { name: "  Normalized tag  " },
      context: {
        workspaceId: "workspace",
        adminUserId: "admin",
        policy: defaultAdminPolicy(),
        clockify: fake.client,
        operationJournal: {
          prepare(_actionName, normalizedOperation, mutationPlan) {
            events.push("prepared");
            prepared = normalizedOperation;
            plan = mutationPlan;
            return "operation-1";
          },
          markExecuting() {
            events.push("executing");
          },
          settle() {
            events.push("settled");
          },
        },
      },
    });

    expect(events).toEqual(["prepared", "executing", "host", "settled"]);
    expect(prepared).toEqual({ body: { name: "Normalized tag" } });
    expect(plan).toEqual({ mode: "single", steps: [{ id: "create-tag", kind: "primary" }] });
    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: true } });
  });
});
