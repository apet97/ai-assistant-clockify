import { describe, expect, it, vi } from "vitest";
import { planConversation } from "../../src/assistant/planner.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import { catalogForModel } from "../../src/harness/catalog.js";
import { INTERNAL_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";

function fakeModel(responses: string[]): ModelClient {
  const queue = [...responses];
  return {
    complete: vi.fn(async () => queue.shift() ?? "{}"),
  };
}

const validPlan = JSON.stringify({
  kind: "actions",
  text: "Starting your timer.",
  actions: [{ name: "clockify_start_timer", arguments: { description: "Deep Work" } }],
});

function baseInput(modelClient: ModelClient) {
  return {
    modelClient,
    messages: [{ role: "user" as const, content: "start a timer" }],
    actionCatalog: catalogForModel(INTERNAL_ACTION_CATALOG),
    policy: defaultAdminPolicy(),
  };
}

describe("planConversation", () => {
  it("returns a validated action plan on the first valid response", async () => {
    const model = fakeModel([validPlan]);
    const plan = await planConversation(baseInput(model));
    expect(plan.kind).toBe("actions");
    expect(plan.actions?.[0].name).toBe("clockify_start_timer");
    expect(model.complete).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once on invalid JSON and then succeeds", async () => {
    const model = fakeModel(["this is not json", validPlan]);
    const plan = await planConversation(baseInput(model));
    expect(plan.kind).toBe("actions");
    expect(model.complete).toHaveBeenCalledTimes(2);
  });

  it("returns a safe clarify result when the second response is still invalid", async () => {
    const model = fakeModel(["nope", "still not json"]);
    const plan = await planConversation(baseInput(model));
    expect(plan.kind).toBe("clarify");
    expect(plan.text).toBeTruthy();
    expect(model.complete).toHaveBeenCalledTimes(2);
  });

  it("accepts a plan wrapped in a markdown code fence", async () => {
    const fenced = "```json\n" + validPlan + "\n```";
    const model = fakeModel([fenced]);
    const plan = await planConversation(baseInput(model));
    expect(plan.kind).toBe("actions");
    expect(model.complete).toHaveBeenCalledTimes(1);
  });

  it("rejects a structurally invalid plan (missing kind) and retries", async () => {
    const model = fakeModel(['{"text":"hi"}', validPlan]);
    const plan = await planConversation(baseInput(model));
    expect(plan.kind).toBe("actions");
    expect(model.complete).toHaveBeenCalledTimes(2);
  });
});
