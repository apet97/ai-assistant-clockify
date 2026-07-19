import type { Response } from "express";
import type { ChatEvent } from "../shared/contracts.js";

/**
 * Open an NDJSON streaming response: set the streaming headers, wire cooperative
 * cancellation, and hand back a line-writer + the abort signal.
 *
 * Used by the two streaming routes (`/chat/stream`,
 * `/confirmations/:id/confirm?stream=1`). The returned `signal` is fired when the
 * client (iframe/proxy) drops the connection mid-turn — so no further model calls
 * or writes run for a turn nobody is watching. `res.on("close")` fires on a
 * normal end too, but aborting after we've ended is a harmless no-op (the turn
 * already finished).
 *
 * `X-Accel-Buffering: no` keeps a proxy from buffering the stream; the writer
 * appends a newline per event so each line is a self-contained JSON object.
 */
export function openNdjsonStream(res: Response): { write: (event: ChatEvent) => void; signal: AbortSignal } {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  // Streams carry private admin text, previews, and receipts. `no-cache` alone
  // still permits storage after revalidation, so retain the API-wide no-store
  // boundary while also prohibiting proxy transformations/buffering.
  res.setHeader("Cache-Control", "private, no-store, no-transform");
  res.setHeader("X-Accel-Buffering", "no"); // don't let a proxy buffer the stream
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  const write = (event: ChatEvent): void => {
    res.write(`${JSON.stringify(event)}\n`);
  };
  return { write, signal: ac.signal };
}

/**
 * Finish an already-started NDJSON response after an unexpected server error.
 * EOF without `done` is a protocol truncation, so send the terminal marker after
 * the useful error instead of making the client replace it with a generic one.
 */
export function finishNdjsonWithServerError(res: Response): void {
  try {
    const event = { type: "error", code: "server_error", message: "Something went wrong." } satisfies ChatEvent;
    res.write(`${JSON.stringify(event)}\n`);
  } catch {
    // The socket may already be torn down. Continue to the best-effort close.
  }
  try {
    const done = { type: "done" } satisfies ChatEvent;
    res.write(`${JSON.stringify(done)}\n`);
  } catch {
    // Same: a disconnected client cannot receive a terminal marker.
  }
  try {
    res.end();
  } catch {
    // Best-effort terminal flush only.
  }
}
