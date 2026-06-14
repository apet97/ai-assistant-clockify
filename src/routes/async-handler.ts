import type { Request, Response, NextFunction } from "express";

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
