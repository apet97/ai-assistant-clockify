import type { Request, Response, NextFunction } from "express";
import type { KeyedFifo } from "./fifo-lock.js";

/**
 * Express 4 does NOT catch rejections from async route handlers: a store write
 * that throws mid-turn (e.g. SQLITE_BUSY) would otherwise leave the request
 * hanging forever AND surface as a fatal unhandledRejection. asyncHandler routes
 * any rejection to next(err) so the terminal error middleware (createApp) returns
 * a calm 5xx and the server stays up for every other admin.
 *
 * Extracted from api.ts (plan 005 Phase 1) — a pure higher-order wrapper that
 * closes over no router or `deps` state.
 */
export function asyncHandler(
  handler: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/**
 * Async route wrapper for session-scoped mutation flows. Unlike response-event
 * middleware, the FIFO owns the handler promise itself, so the lock is held
 * through post-response journaling/bookkeeping. A request that disconnects while
 * queued is skipped before its handler starts; the fulfilled skip still advances
 * the keyed tail, so later requests are never poisoned.
 */
export function fifoAsyncHandler(
  fifo: KeyedFifo,
  keyForRequest: (req: Request) => string | undefined,
  handler: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const key = keyForRequest(req);
    if (!key) {
      handler(req, res).catch(next);
      return;
    }

    let disconnected = req.aborted || res.destroyed;
    const markDisconnected = (): void => {
      if (!res.writableEnded) disconnected = true;
    };
    res.once("close", markDisconnected);

    void fifo
      .run(key, async () => {
        if (disconnected || req.aborted || res.destroyed) return;
        await handler(req, res);
      })
      .catch(next)
      .finally(() => {
        res.off("close", markDisconnected);
      });
  };
}
