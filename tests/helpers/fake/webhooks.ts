import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type { WebhookSummary } from "../../../src/clockify/ports/webhooks.js";
import { fakeListResult, type FakeContext } from "./state.js";

export function makeFakeWebhooks({ state, seed, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "listWebhooks"
  | "getWebhook"
  | "prepareWebhookUpdate"
  | "createWebhookAtomic"
  | "updateWebhookAtomic"
  | "deleteWebhookAtomic"
  | "createWebhook"
  | "updateWebhook"
  | "deleteWebhook"
  | "listWebhookEvents"
  | "listWebhookLogs"
> {
  const createWebhookAtomic: WorkspaceClient["createWebhookAtomic"] = async (input) => {
    bump("createWebhookAtomic");
    bump("createWebhook");
    const w: WebhookSummary = {
      id: nextId("webhook"), name: input.name, url: input.url, webhookEvent: input.webhookEvent,
      triggerSource: input.triggerSource ?? ["ws-1"], triggerSourceType: input.triggerSourceType ?? "WORKSPACE_ID",
    };
    state.webhooks.push(w);
    return { id: w.id, name: w.name };
  };
  const updateWebhookAtomic: WorkspaceClient["updateWebhookAtomic"] = async (id, input) => {
    bump("updateWebhookAtomic");
    bump("updateWebhook");
    const w = state.webhooks.find((x) => x.id === id);
    if (w) Object.assign(w, input);
    return { id, name: w?.name ?? id };
  };
  const deleteWebhookAtomic: WorkspaceClient["deleteWebhookAtomic"] = async (id) => {
    bump("deleteWebhookAtomic");
    bump("deleteWebhook");
    state.webhooks = state.webhooks.filter((w) => w.id !== id);
    state.deleted.push({ entityType: "webhook", id });
  };
  return {
    async listWebhooks() {
      bump("listWebhooks");
      return fakeListResult(seed, "listWebhooks", state.webhooks);
    },
    async getWebhook(id) {
      bump("getWebhook");
      return state.webhooks.find((w) => w.id === id) ?? null;
    },
    async prepareWebhookUpdate(id, patch) {
      bump("prepareWebhookUpdate");
      const w = state.webhooks.find((x) => x.id === id);
      if (!w) throw new Error("webhook_not_found");
      return {
        name: patch.name ?? w.name ?? id,
        url: patch.url ?? w.url ?? "https://example.invalid/hook",
        webhookEvent: patch.webhookEvent ?? w.webhookEvent ?? "NEW_TIME_ENTRY",
        triggerSource: patch.triggerSource ?? w.triggerSource ?? ["ws-1"],
        triggerSourceType: patch.triggerSourceType ?? w.triggerSourceType ?? "WORKSPACE_ID",
      };
    },
    createWebhookAtomic,
    updateWebhookAtomic,
    deleteWebhookAtomic,
    createWebhook: createWebhookAtomic,
    async updateWebhook(id, patch) {
      const w = state.webhooks.find((x) => x.id === id);
      if (!w) throw new Error("webhook_not_found");
      return updateWebhookAtomic(id, {
        name: patch.name ?? w.name ?? id,
        url: patch.url ?? w.url ?? "https://example.invalid/hook",
        webhookEvent: patch.webhookEvent ?? w.webhookEvent ?? "NEW_TIME_ENTRY",
        triggerSource: patch.triggerSource ?? w.triggerSource ?? ["ws-1"],
        triggerSourceType: patch.triggerSourceType ?? w.triggerSourceType ?? "WORKSPACE_ID",
      });
    },
    deleteWebhook: deleteWebhookAtomic,
    async listWebhookEvents() {
      bump("listWebhookEvents");
      return fakeListResult(seed, "listWebhookEvents", ["NEW_TIME_ENTRY", "TIMER_STOPPED"]);
    },
    async listWebhookLogs(id) {
      bump("listWebhookLogs");
      void id;
      return fakeListResult(seed, "listWebhookLogs", []);
    },
  };
}
