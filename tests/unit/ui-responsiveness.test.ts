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
});
