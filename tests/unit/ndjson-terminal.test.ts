import type { Response as ExpressResponse } from "express";
import { describe, expect, it } from "vitest";
import { finishNdjsonWithServerError } from "../../src/routes/ndjson.js";
import { pumpNdjson } from "../../src/ui/api-client.js";
import type { ChatEvent } from "../../src/shared/contracts.js";

function byteStreamResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const reader = {
    read(): Promise<{ value: Uint8Array | undefined; done: boolean }> {
      if (offset >= bytes.length) return Promise.resolve({ value: undefined, done: true });
      const value = bytes.slice(offset, offset + 3);
      offset += value.byteLength;
      return Promise.resolve({ value, done: false });
    },
  };
  return { body: { getReader: () => reader } } as unknown as Response;
}

describe("terminal NDJSON server errors", () => {
  it("preserves the useful server error and terminates with exactly one done marker", async () => {
    const chunks: string[] = [];
    let ended = false;
    const response = {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
      end() {
        ended = true;
      },
    } as unknown as ExpressResponse;

    finishNdjsonWithServerError(response);

    const events: ChatEvent[] = [];
    await pumpNdjson(byteStreamResponse(chunks.join("")), (event) => events.push(event));
    expect(events).toEqual([
      { type: "error", code: "server_error", message: "Something went wrong." },
      { type: "done" },
    ]);
    expect(ended).toBe(true);
  });
});
