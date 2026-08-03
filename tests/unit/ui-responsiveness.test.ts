import { describe, expect, it } from "vitest";
import { submitMessage, type ComposerHooks, type ChatApiLike } from "../../src/ui/main.js";

function recorder() {
  const events: string[] = [];
  const hooks: ComposerHooks = {
    onWorking: (w) => events.push(`working:${w}`),
    onAssistant: (t) => events.push(`assistant:${t}`),
    onResults: (r) => events.push(`results:${r.length}`),
    onError: (m) => events.push(`error:${m}`),
  };
  return { hooks, events };
}

describe("submitMessage (responsive send flow)", () => {
  it("announces working BEFORE the call, renders reply + results, then clears working", async () => {
    const api: ChatApiLike = {
      sendMessage: async () => ({ ok: true, reply: { kind: "answer", text: "hi" }, results: [{ kind: "clarify", message: "x" }] }),
    };
    const { hooks, events } = recorder();
    await submitMessage(api, "hello", hooks);
    expect(events[0]).toBe("working:true");
    expect(events).toContain("assistant:hi");
    expect(events).toContain("results:1");
    expect(events[events.length - 1]).toBe("working:false");
  });

  it("shows no assistant bubble when the reply text is empty (tool-mode turns)", async () => {
    const api: ChatApiLike = {
      sendMessage: async () => ({ ok: true, reply: { kind: "actions", text: "" }, results: [] }),
    };
    const { hooks, events } = recorder();
    await submitMessage(api, "create a tag", hooks);
    expect(events.some((e) => e.startsWith("assistant:"))).toBe(false);
    expect(events).toContain("results:0");
    expect(events[events.length - 1]).toBe("working:false");
  });

  it("on a transport failure: surfaces an error and ALWAYS clears working (no assistant bubble)", async () => {
    const api: ChatApiLike = {
      sendMessage: async () => {
        throw new Error("network down");
      },
    };
    const { hooks, events } = recorder();
    await submitMessage(api, "hello", hooks);
    expect(events[0]).toBe("working:true");
    expect(events.some((e) => e.startsWith("error:"))).toBe(true);
    expect(events.some((e) => e.startsWith("assistant:"))).toBe(false);
    expect(events[events.length - 1]).toBe("working:false");
  });

  it("renders a v2 presented-result attachment from an embedded run-event page as a result card", async () => {
    const api: ChatApiLike = {
      sendMessage: async () => ({
        ok: true,
        reply: { kind: "actions", text: "" },
        results: [],
        runId: "run-1",
        runEvents: {
          runId: "run-1",
          nextAfter: 1,
          hasMore: false,
          lastSequence: 1,
          events: [{
            runId: "run-1",
            sequence: 1,
            event: { eventType: "operation.terminal", payload: {}, createdAt: "2026-08-03T00:00:00.000Z" },
            attachment: {
              kind: "presented_result",
              actionResultId: "ar-1",
              envelope: {
                presentation: {
                  status: "succeeded",
                  title: "Tag created",
                  summary: "Created tag Design.",
                  facts: [],
                  warnings: [],
                  references: [],
                },
              },
            },
          }],
        },
      }),
    };
    const results: unknown[] = [];
    const { hooks, events } = recorder();
    hooks.onResults = (r) => { results.push(...r); events.push(`results:${r.length}`); };
    await submitMessage(api, "create a tag", hooks);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "receipt", receipt: { action: "Tag created", presentedStatus: "succeeded" } });
    // No duplicate assistant bubble from the run event even though the turn had no reply text.
    expect(events.some((e) => e.startsWith("assistant:"))).toBe(false);
  });

  it("renders a pending-confirmation attachment with its fresh nonce as a preview card", async () => {
    const api: ChatApiLike = {
      sendMessage: async () => ({
        ok: true,
        reply: { kind: "actions", text: "" },
        results: [],
        runId: "run-2",
        runEvents: {
          runId: "run-2",
          nextAfter: 1,
          hasMore: false,
          lastSequence: 1,
          events: [{
            runId: "run-2",
            sequence: 1,
            event: { eventType: "operation.pending_confirmation", payload: {}, createdAt: "2026-08-03T00:00:00.000Z" },
            attachment: {
              kind: "pending_confirmation",
              confirmationId: "confirm-1",
              envelope: {
                presentation: {
                  status: "pending_confirmation",
                  title: "Delete project",
                  summary: "This will delete Alpha.",
                  facts: [],
                  warnings: [],
                  references: [],
                },
                confirmation: { id: "confirm-1", nonce: "fresh-nonce", expiresAt: "2026-08-03T00:05:00.000Z" },
              },
            },
          }],
        },
      }),
    };
    const results: unknown[] = [];
    const { hooks } = recorder();
    hooks.onResults = (r) => { results.push(...r); };
    await submitMessage(api, "delete a project", hooks);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "preview", previewId: "confirm-1", nonce: "fresh-nonce" });
  });

  it("does not duplicate the answer bubble when reply.text and an assistant_message run event both exist", async () => {
    const api: ChatApiLike = {
      sendMessage: async () => ({
        ok: true,
        reply: { kind: "answer", text: "Here you go." },
        results: [],
        runId: "run-3",
        runEvents: {
          runId: "run-3",
          nextAfter: 1,
          hasMore: false,
          lastSequence: 1,
          events: [{
            runId: "run-3",
            sequence: 1,
            event: { eventType: "model.completed", payload: {}, createdAt: "2026-08-03T00:00:00.000Z" },
            attachment: { kind: "assistant_message", messageId: "m1", text: "Here you go." },
          }],
        },
      }),
    };
    const { hooks, events } = recorder();
    await submitMessage(api, "hello", hooks);
    expect(events.filter((e) => e.startsWith("assistant:"))).toEqual(["assistant:Here you go."]);
  });

  it("v1 JSON responses without runId/runEvents behave exactly as before", async () => {
    const api: ChatApiLike = {
      sendMessage: async () => ({
        ok: true,
        reply: { kind: "answer", text: "Done." },
        results: [{ kind: "receipt", receipt: { ok: true, action: "clockify_tags_create" } }],
      }),
    };
    const results: unknown[] = [];
    const { hooks, events } = recorder();
    hooks.onResults = (r) => { results.push(...r); events.push(`results:${r.length}`); };
    await submitMessage(api, "create a tag", hooks);
    expect(results).toHaveLength(1);
    expect(events).toEqual(["working:true", "assistant:Done.", "results:1", "working:false"]);
  });
});
