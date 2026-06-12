import { describe, expect, it } from "vitest";
import { createController, featureGroupRows, type ChatApi } from "../../src/ui/main.js";

function fakeApi(): ChatApi & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const bump = (key: string): void => {
    calls[key] = (calls[key] ?? 0) + 1;
  };
  return {
    calls,
    async getPermissions() {
      bump("getPermissions");
      return { ok: true, policy: { version: 1, groups: {} }, firstRun: true, featureGroups: [] };
    },
    async savePermissions() {
      bump("savePermissions");
      return { ok: true };
    },
    async getHistory() {
      bump("getHistory");
      return { ok: true, messages: [], pendingPreviews: [] };
    },
    async sendMessage() {
      bump("sendMessage");
      return { ok: true, reply: { kind: "answer", text: "" }, results: [] };
    },
    async streamMessage(_message: string, onEvent: (event: { type: string }) => void) {
      bump("streamMessage");
      onEvent({ type: "done" });
    },
    async confirmPreview() {
      bump("confirmPreview");
      return { ok: true };
    },
    async confirmStream(_ref, onEvent) {
      bump("confirmStream");
      onEvent({ type: "receipt", receipt: { ok: true, action: "x" } });
      onEvent({ type: "done" });
    },
    async cancelPreview() {
      bump("cancelPreview");
      return { ok: true };
    },
    async undo() {
      bump("undo");
      return { ok: true };
    },
  };
}

describe("ui controller", () => {
  it("first-run save calls the permissions confirm endpoint", async () => {
    const api = fakeApi();
    await createController(api).savePermissions({ invoices: "off" });
    expect(api.calls.savePermissions).toBe(1);
  });

  it("chat send calls the messages endpoint", async () => {
    const api = fakeApi();
    await createController(api).send("hello");
    expect(api.calls.sendMessage).toBe(1);
    expect(api.calls.confirmPreview ?? 0).toBe(0);
  });

  it("confirm button calls the confirmation endpoint", async () => {
    const api = fakeApi();
    await createController(api).confirm({ previewId: "p1", nonce: "n1" });
    expect(api.calls.confirmPreview).toBe(1);
  });

  it("confirm all calls the confirmation endpoint for each batch item", async () => {
    const api = fakeApi();
    await createController(api).confirmAll([
      { previewId: "p1", nonce: "n1" },
      { previewId: "p2", nonce: "n2" },
    ]);
    expect(api.calls.confirmPreview).toBe(2);
  });

  it("a typed 'yes' appends a message only and never calls the confirmation endpoint", async () => {
    const api = fakeApi();
    await createController(api).send("yes");
    expect(api.calls.sendMessage).toBe(1);
    expect(api.calls.confirmPreview ?? 0).toBe(0);
  });

  it("undo calls the undo endpoint", async () => {
    const api = fakeApi();
    await createController(api).undo("u1");
    expect(api.calls.undo).toBe(1);
  });

  it("the permission panel renders every feature group", () => {
    const rows = featureGroupRows({
      version: 1,
      groups: {
        time_tracking: "read_write",
        work_structure: "read_write",
        reports: "read_write",
        invoices: "read_write",
        expenses: "read_write",
        users_groups: "read_write",
        time_off_approvals: "read_write",
        scheduling: "read_write",
        webhooks: "read_write",
        workspace_settings: "read_write",
      },
    });
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.group)).toContain("invoices");
  });
});
