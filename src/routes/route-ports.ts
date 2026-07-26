import type { NextFunction, Request, Response } from "express";
import type { SessionClaims } from "../auth/sessions.js";

/**
 * Shared transport-route port types (T16-F). Route files depend on these
 * narrow function shapes — injected by the api.ts composition root — instead
 * of importing the store, harness, model, or presenter layers themselves.
 */

/** An async handler wrapped for Express error routing (asyncHandler) or the
 * per-session FIFO (sessionAsyncHandler). */
export type WrappedHandler = (
  handler: (req: Request, res: Response) => Promise<unknown>,
) => (req: Request, res: Response, next: NextFunction) => void;

/** The pipeline's authenticated-session gate: resolves verified claims or
 * writes the terminal 401/403/503 itself and returns undefined. */
export type RequireSession = (req: Request, res: Response) => Promise<(SessionClaims & { installationGeneration: number }) | undefined>;
