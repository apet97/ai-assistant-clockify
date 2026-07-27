import { describe, expect, it } from "vitest";
import { restoreRunEvents, RunEventCursor, applyRunEventAttachment, PreviewBuffer } from "../../src/ui/shared.js";

describe("RunEventCursor", () => {
  it("deduplicates by runId+sequence and requires contiguous delivery", () => {
    const cursor = new RunEventCursor("run-1");
    expect(cursor.accept(1)).toBe(true);
    expect(cursor.accept(1)).toBe(false);
    expect(cursor.accept(3)).toBe(false);
    expect(cursor.accept(2)).toBe(true);
    expect(cursor.highestSequence).toBe(2);
  });
});

describe("restoreRunEvents", () => {
  it("recovers gaps by paging after the highest contiguous sequence", async () => {
    const cursor = new RunEventCursor("run-1");
    const seen: string[] = [];
    const pages = new Map<number, {
      ok: true;
      runId: string;
      events: Array<{
        runId: string;
        sequence: number;
        event: { eventType: string; payload: Record<string, unknown>; createdAt: string };
        attachment?: { kind: "assistant_message"; messageId: string; text: string };
      }>;
      nextAfter: number;
      hasMore: boolean;
      lastSequence: number;
    }>([
      [0, {
        ok: true,
        runId: "run-1",
        events: [{
          runId: "run-1",
          sequence: 1,
          event: { eventType: "run.started", payload: {}, createdAt: "2026-01-01T00:00:00.000Z" },
        }],
        nextAfter: 1,
        hasMore: true,
        lastSequence: 2,
      }],
      [1, {
        ok: true,
        runId: "run-1",
        events: [{
          runId: "run-1",
          sequence: 2,
          event: { eventType: "model.completed", payload: {}, createdAt: "2026-01-01T00:00:01.000Z" },
          attachment: { kind: "assistant_message", messageId: "m1", text: "Done." },
        }],
        nextAfter: 2,
        hasMore: false,
        lastSequence: 2,
      }],
    ]);
    await restoreRunEvents(
      async (_runId, after) => pages.get(after)! as import("../../src/ui/shared.js").RunEventPageResponse,
      "run-1",
      cursor,
      {
        onAssistant: (text) => seen.push(text),
        onResults: () => undefined,
        onError: () => undefined,
      },
    );
    expect(seen).toEqual(["Done."]);
    expect(cursor.highestSequence).toBe(2);
  });
});

describe("applyRunEventAttachment", () => {
  it("renders assistant_message attachments as assistant text", () => {
    const seen: string[] = [];
    const buffer = new PreviewBuffer(() => undefined);
    applyRunEventAttachment({
      type: "run_event",
      runId: "run-1",
      sequence: 1,
      event: { eventType: "model.completed" as const, payload: { modelCall: 1, providerAttempts: 1 as const, usage: {}, latencyMs: 1 }, createdAt: "2026-01-01T00:00:00.000Z" },
      attachment: { kind: "assistant_message", messageId: "m1", text: "Hello" },
    }, {
      onAssistant: (text) => seen.push(text),
      onResults: () => undefined,
      onError: () => undefined,
    }, buffer);
    expect(seen).toEqual(["Hello"]);
  });
});
