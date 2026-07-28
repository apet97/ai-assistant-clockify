import { capToolResultForModel } from "../assistant/tool-results.js";
import type { ActionResult } from "../harness/action.js";

/**
 * What a v2 run learned from executing one tool call, in the bounded form the
 * model is allowed to see.
 *
 * v2 never persists a provider transcript: every model request is rebuilt from
 * durable state (`buildFreshMessages`). That is a privacy property worth
 * keeping, but it only works if what the run learned is rebuilt WITH it —
 * otherwise the model is handed byte-identical input on every iteration and the
 * loop cannot progress. Observations are that rebuilt channel.
 */
export type RunObservation =
  | { kind: "result"; actionName: string; summary: string }
  | { kind: "denied"; actionName: string; code: string };

/** Deterministic model-visible lines. Data is quoted as data, never as instruction. */
export function formatObservations(observations: readonly RunObservation[]): string[] {
  return observations.map((observation) =>
    observation.kind === "result"
      ? `${observation.actionName} returned: ${observation.summary}`
      : `${observation.actionName} was refused (${observation.code}). Do not repeat this call unchanged; either adjust it or explain the refusal to the admin.`,
  );
}

/**
 * The bounded model-visible copy of one stored action result.
 *
 * Reuses v1's `capToolResultForModel` byte cap so both engines prune the same
 * way; a non-receipt outcome (preview/clarify) carries its own admin-facing
 * prose, which the model does not need and must not narrate as a completed
 * effect.
 */
export function summarizeActionResultForModel(stored: unknown): string | undefined {
  if (!stored || typeof stored !== "object") return undefined;
  const result = stored as ActionResult;
  if (result.kind === "receipt" || result.kind === "partial") {
    return capToolResultForModel(result.receipt);
  }
  return undefined;
}
