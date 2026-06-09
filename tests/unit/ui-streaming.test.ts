import { describe, expect, it } from "vitest";
import {
  createNdjsonParser,
  submitStreaming,
  type ComposerHooks,
  type StreamEvent,
} from "../../src/ui/main.js";

describe("createNdjsonParser", () => {
  it("emits one event per complete line and buffers the partial remainder", () => {
    const events: unknown[] = [];
    const feed = createNdjsonParser((e) => events.push(e));
    feed('{"type":"result","x":1}\n{"type":"reply"');
    expect(events).toEqual([{ type: "result", x: 1 }]); // the incomplete second line is buffered
    feed(',"text":"hi"}\n');
    expect(events).toEqual([{ type: "result", x: 1 }, { type: "reply", text: "hi" }]);
  });

  it("reassembles a line split across chunks and ignores malformed lines", () => {
    const events: unknown[] = [];
    const feed = createNdjsonParser((e) => events.push(e));
    feed('{"ty');
    feed('pe":"a"}\nnot json\n{"type":"done"}\n');
    expect(events).toEqual([{ type: "a" }, { type: "done" }]);
  });
});

function recorder() {
  const log: string[] = [];
  const hooks: ComposerHooks = {
    onWorking: (w) => log.push(`working:${w}`),
    onAssistant: (t) => log.push(`assistant:${t}`),
    onResults: (r) => log.push(`results:${r.map((x) => x.kind).join(",")}`),
    onError: (m) => log.push(`error:${m}`),
  };
  return { hooks, log };
}

function streamApi(events: StreamEvent[]) {
  return {
    streamMessage: async (_message: string, onEvent: (e: StreamEvent) => void): Promise<void> => {
      for (const e of events) onEvent(e);
    },
  };
}

describe("submitStreaming", () => {
  it("streams receipts immediately but BATCHES previews until the reply (Confirm all stays grouped)", async () => {
    const api = streamApi([
      { type: "result", result: { kind: "receipt", receipt: { ok: true, action: "x" } } },
      { type: "result", result: { kind: "preview", previewId: "p1", nonce: "n1", preview: { actionLabel: "a", expectedChanges: [], reversibility: "", warnings: [] } } },
      { type: "result", result: { kind: "preview", previewId: "p2", nonce: "n2", preview: { actionLabel: "b", expectedChanges: [], reversibility: "", warnings: [] } } },
      { type: "reply", kind: "actions", text: "review and confirm" },
      { type: "done" },
    ]);
    const { hooks, log } = recorder();
    await submitStreaming(api, "m", hooks);
    expect(log[0]).toBe("working:true");
    expect(log).toContain("results:receipt"); // receipt streamed on its own
    expect(log).toContain("results:preview,preview"); // both previews flushed together
    expect(log).toContain("assistant:review and confirm");
    expect(log.indexOf("results:preview,preview")).toBeLessThan(log.indexOf("assistant:review and confirm"));
    expect(log[log.length - 1]).toBe("working:false");
  });

  it("surfaces a server error event and always clears working", async () => {
    const api = streamApi([{ type: "error", code: "model_unavailable", message: "down" }, { type: "done" }]);
    const { hooks, log } = recorder();
    await submitStreaming(api, "m", hooks);
    expect(log.some((l) => l.startsWith("error:"))).toBe(true);
    expect(log[log.length - 1]).toBe("working:false");
  });
});
