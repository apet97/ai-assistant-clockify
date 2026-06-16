import { describe, expect, it } from "vitest";
import {
  createNdjsonParser,
  submitStreaming,
  type ComposerHooks,
  type StreamEvent,
} from "../../src/ui/main.js";
import {
  dispatchStreamEvent,
  PreviewBuffer,
  STALE_NONCE_CODE,
  type ChatResult,
  type StreamDispatchHooks,
} from "../../src/ui/shared.js";
import { pumpNdjson } from "../../src/ui/api-client.js";

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

function recorder(withStatus = false) {
  const log: string[] = [];
  const hooks: ComposerHooks = {
    onWorking: (w) => log.push(`working:${w}`),
    onAssistant: (t) => log.push(`assistant:${t}`),
    onResults: (r) => log.push(`results:${r.map((x) => x.kind).join(",")}`),
    onError: (m) => log.push(`error:${m}`),
    ...(withStatus ? { onStatus: (label: string) => log.push(`status:${label}`) } : {}),
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

  it("dispatches status labels to onStatus; harmless without the hook; unknown event types stay ignored", async () => {
    const events: StreamEvent[] = [
      { type: "status", action: "clockify_tags_list", label: "Tags list" },
      { type: "some_future_event" },
      { type: "reply", kind: "answer", text: "done" },
      { type: "done" },
    ];
    const withHook = recorder(true);
    await submitStreaming(streamApi(events), "m", withHook.hooks);
    expect(withHook.log).toContain("status:Tags list");
    expect(withHook.log.filter((l) => l.startsWith("error"))).toEqual([]); // unknown type ignored

    const withoutHook = recorder(false);
    await submitStreaming(streamApi(events), "m", withoutHook.hooks); // must not throw
    expect(withoutHook.log).toContain("assistant:done");
  });

  it("surfaces a server error event and always clears working", async () => {
    const api = streamApi([{ type: "error", code: "model_unavailable", message: "down" }, { type: "done" }]);
    const { hooks, log } = recorder();
    await submitStreaming(api, "m", hooks);
    expect(log.some((l) => l.startsWith("error:"))).toBe(true);
    expect(log[log.length - 1]).toBe("working:false");
  });
});

function preview(previewId: string, nonce: string): ChatResult {
  return {
    kind: "preview",
    previewId,
    nonce,
    preview: { actionLabel: previewId, expectedChanges: [], reversibility: "", warnings: [] },
  };
}

describe("PreviewBuffer", () => {
  it("flush emits ALL pushed previews as ONE batch", () => {
    const batches: ChatResult[][] = [];
    const buffer = new PreviewBuffer((r) => batches.push(r));
    buffer.push(preview("p1", "n1"));
    buffer.push(preview("p2", "n2"));
    buffer.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0].map((r) => (r as { previewId: string }).previewId)).toEqual(["p1", "p2"]);
  });

  it("an empty flush is a no-op", () => {
    const batches: ChatResult[][] = [];
    const buffer = new PreviewBuffer((r) => batches.push(r));
    buffer.flush();
    expect(batches).toEqual([]);
  });

  it("push-after-flush starts a fresh batch", () => {
    const batches: ChatResult[][] = [];
    const buffer = new PreviewBuffer((r) => batches.push(r));
    buffer.push(preview("p1", "n1"));
    buffer.flush();
    buffer.push(preview("p2", "n2"));
    buffer.flush();
    expect(batches.map((b) => b.map((r) => (r as { previewId: string }).previewId))).toEqual([["p1"], ["p2"]]);
  });
});

function dispatchRecorder() {
  const log: string[] = [];
  const hooks: StreamDispatchHooks = {
    onAssistant: (t) => log.push(`assistant:${t}`),
    onResults: (r) => log.push(`results:${r.map((x) => x.kind).join(",")}`),
    onError: (m) => log.push(`error:${m}`),
    onStatus: (label) => log.push(`status:${label}`),
    onStale: (m) => log.push(`stale:${m}`),
  };
  return { hooks, log };
}

describe("dispatchStreamEvent", () => {
  it("buffers a preview but renders a receipt immediately", () => {
    const { hooks, log } = dispatchRecorder();
    const batches: ChatResult[][] = [];
    const buffer = new PreviewBuffer((r) => batches.push(r));
    dispatchStreamEvent({ type: "result", result: preview("p1", "n1") }, hooks, buffer, "fallback");
    expect(batches).toEqual([]); // buffered, not rendered
    dispatchStreamEvent(
      { type: "result", result: { kind: "receipt", receipt: { ok: true, action: "x" } } },
      hooks,
      buffer,
      "fallback",
    );
    expect(log).toContain("results:receipt"); // rendered immediately
  });

  it("a reply FLUSHES the buffer THEN appends the reply text (order matters)", () => {
    const { hooks, log } = dispatchRecorder();
    const buffer = new PreviewBuffer((r) => hooks.onResults(r));
    dispatchStreamEvent({ type: "result", result: preview("p1", "n1") }, hooks, buffer, "fallback");
    dispatchStreamEvent({ type: "reply", text: "review and confirm" }, hooks, buffer, "fallback");
    expect(log).toEqual(["results:preview", "assistant:review and confirm"]);
  });

  it("routes a stale-nonce error to onStale, a generic error to onError, and a missing message to the fallback", () => {
    const { hooks, log } = dispatchRecorder();
    const buffer = new PreviewBuffer((r) => hooks.onResults(r));
    dispatchStreamEvent({ type: "error", code: STALE_NONCE_CODE, message: "rotated" }, hooks, buffer, "fallback");
    dispatchStreamEvent({ type: "error", code: "model_unavailable", message: "down" }, hooks, buffer, "fallback");
    dispatchStreamEvent({ type: "error" }, hooks, buffer, "fallback");
    expect(log).toEqual(["stale:rotated", "error:down", "error:fallback"]);
  });

  it("drives onStatus and ignores unknown event types", () => {
    const { hooks, log } = dispatchRecorder();
    const buffer = new PreviewBuffer((r) => hooks.onResults(r));
    dispatchStreamEvent({ type: "status", label: "Tags list" }, hooks, buffer, "fallback");
    dispatchStreamEvent({ type: "some_future_event" }, hooks, buffer, "fallback");
    expect(log).toEqual(["status:Tags list"]);
  });

  it("falls back to onError when no onStale is supplied for a stale-nonce error", () => {
    const log: string[] = [];
    const hooks: StreamDispatchHooks = {
      onAssistant: (t) => log.push(`assistant:${t}`),
      onResults: (r) => log.push(`results:${r.length}`),
      onError: (m) => log.push(`error:${m}`),
    };
    const buffer = new PreviewBuffer((r) => hooks.onResults(r));
    dispatchStreamEvent({ type: "error", code: STALE_NONCE_CODE, message: "rotated" }, hooks, buffer, "fallback");
    expect(log).toEqual(["error:rotated"]);
  });
});

describe("STALE_NONCE_CODE", () => {
  it("is the route's invalid_confirmation code", () => {
    expect(STALE_NONCE_CODE).toBe("invalid_confirmation");
  });
});

function byteStreamResponse(text: string, sliceSize: number): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const reader = {
    read(): Promise<{ value: Uint8Array | undefined; done: boolean }> {
      if (offset >= bytes.length) return Promise.resolve({ value: undefined, done: true });
      const value = bytes.slice(offset, offset + sliceSize);
      offset += sliceSize;
      return Promise.resolve({ value, done: false });
    },
  };
  return { body: { getReader: () => reader } } as unknown as Response;
}

describe("pumpNdjson", () => {
  it("emits every complete line across chunk boundaries", async () => {
    const events: StreamEvent[] = [];
    const text = '{"type":"result","x":1}\n{"type":"reply","text":"hi"}\n';
    await pumpNdjson(byteStreamResponse(text, 7), (e) => events.push(e));
    expect(events).toEqual([
      { type: "result", x: 1 } as unknown as StreamEvent,
      { type: "reply", text: "hi" },
    ]);
  });

  // NOTE: against the REAL code a final line WITHOUT a trailing "\n" is NOT
  // emitted — createNdjsonParser buffers the partial remainder and only emits on
  // "\n" (pinned by the createNdjsonParser tests above), and pumpNdjson's
  // `feed(decoder.decode())` flushes trailing UTF-8 BYTES, not buffered lines.
  // (The server always newline-terminates its NDJSON lines.) So we pin BOTH the
  // true contracts the trailing flush + stream-mode decode actually provide:
  it("buffers an un-terminated final line (no spurious emit) — the real contract", async () => {
    const events: StreamEvent[] = [];
    const text = '{"type":"a"}\n{"type":"done"}'; // no trailing \n on the last line
    await pumpNdjson(byteStreamResponse(text, 5), (e) => events.push(e));
    expect(events).toEqual([{ type: "a" } as unknown as StreamEvent]); // 2nd line never terminated
  });

  it("reassembles a multibyte UTF-8 char split across byte chunks (the trailing decoder flush)", async () => {
    const events: StreamEvent[] = [];
    // The em-dash U+2014 is 3 bytes; a 5-byte slice splits it across chunks, so
    // stream-mode decode + the trailing flush must reassemble it intact.
    const text = '{"type":"reply","text":"a\u2014b"}\n';
    await pumpNdjson(byteStreamResponse(text, 5), (e) => events.push(e));
    expect(events).toEqual([{ type: "reply", text: "a\u2014b" }]);
  });
});
