import type { Response } from "express";

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
export function openNdjsonStream(res: Response): { write: (event: unknown) => void; signal: AbortSignal } {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no"); // don't let a proxy buffer the stream
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  const write = (event: unknown): void => {
    res.write(`${JSON.stringify(event)}\n`);
  };
  return { write, signal: ac.signal };
}
