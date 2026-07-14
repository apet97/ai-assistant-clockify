import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type { WebhookSummary } from "../../../src/clockify/ports/webhooks.js";
import { fakeListResult, type FakeContext } from "./state.js";

export function makeFakeWebhooks({ state, seed, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "listWebhooks"
  | "getWebhook"
  | "createWebhook"
  | "updateWebhook"
  | "deleteWebhook"
  | "listWebhookEvents"
  | "listWebhookLogs"
> {
  return {
    async listWebhooks() {
      bump("listWebhooks");
      return fakeListResult(seed, "listWebhooks", state.webhooks);
    },
    async getWebhook(id) {
      bump("getWebhook");
      return state.webhooks.find((w) => w.id === id) ?? null;
    },
    async createWebhook(input) {
      bump("createWebhook");
      const w: WebhookSummary = { id: nextId("webhook"), name: input.name, url: input.url, webhookEvent: input.webhookEvent };
      state.webhooks.push(w);
      return { id: w.id, name: w.name };
    },
    async updateWebhook(id, patch) {
      bump("updateWebhook");
      const w = state.webhooks.find((x) => x.id === id);
      if (w && patch.name !== undefined) w.name = patch.name;
      return { id, name: w?.name ?? id };
    },
    async deleteWebhook(id) {
      bump("deleteWebhook");
      state.webhooks = state.webhooks.filter((w) => w.id !== id);
      state.deleted.push({ entityType: "webhook", id });
    },
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
