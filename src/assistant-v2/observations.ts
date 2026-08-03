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

/** `tool.denied`'s payload schema bounds `code` at 256 UTF-8 bytes
 * (`events.ts` `MAX_UTF8_BYTES`). A code built from a thrown exception message
 * can exceed that, and an over-long code would fail Zod inside the event
 * transaction — trading a livelock for a crash. Bound it at the source. */
const MAX_CODE_BYTES = 256;

/** The truncation marker, counted against the bound rather than added past it. */
const ELLIPSIS = "…";
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, "utf8");

export function boundedDenialCode(code: string): string {
  const buffer = Buffer.from(code, "utf8");
  if (buffer.byteLength <= MAX_CODE_BYTES) return code;
  // Decode the head and drop a trailing replacement character: slicing raw
  // bytes can cut a multi-byte sequence in half, and the decoder would turn
  // that remnant into U+FFFD rather than dropping it.
  const head = new TextDecoder("utf-8")
    .decode(buffer.subarray(0, MAX_CODE_BYTES - ELLIPSIS_BYTES))
    .replace(/�$/, "");
  return `${head}${ELLIPSIS}`;
}

/**
 * What each refusal MEANS, and what to do next.
 *
 * A bare snake_case code plus "explain the refusal to the admin" asks the model
 * to explain something it was never told. In production a run refused with
 * `mixed_discovery_batch` reported that "the system wants me to first discover
 * the right API operations", then burned its whole discovery budget, then
 * reported `too_many_refinements` as "my queries were too narrow or
 * over-specified". Both are inventions, and neither points at the real fix —
 * which for the first one is simply "send those two calls in separate steps".
 *
 * Each line is the CAUSE and the NEXT STEP, in the model's terms. This is
 * deliberately not `copyFor` from `terminal-reason.ts`: that is admin copy for a
 * run that already ended ("Nothing was changed. Please try again."), while these
 * describe a single denied call inside a run that is still going, and must be
 * actionable rather than consoling.
 */
const DENIAL_GUIDANCE: Readonly<Record<string, string>> = {
  mixed_discovery_batch:
    "an operation search and a data call were in the SAME batch. Send the search first, then the data calls in a separate step.",
  too_many_refinements:
    "the per-run search budget is spent. This is a budget limit, NOT a comment on your query wording. Work with the operations you have already loaded, or tell the admin a new chat resets the search budget.",
  duplicate_tool_call_id: "two calls in that batch shared one id. Give each call a distinct id.",
  duplicate_write: "that exact change was already requested in this run. Do not request it again.",
  budget_exhausted: "this run's step budget is spent. Stop and report what was and was not done.",
  read_write_dependency:
    "a change depended on data not yet read. Read first, then request the change in a later step.",
  tool_not_loaded: "that operation is not loaded in this run. Search for it first, then call it.",
  unknown_tool: "no operation by that name exists. Do not retry it under a guessed name.",
  unknown_action: "no operation by that name exists. Do not retry it under a guessed name.",
  stale_catalog_hash: "the operation set changed mid-run. Search again before calling it.",
  invalid_args: "the arguments failed validation. Fix the named fields; do not resend them unchanged.",
  policy_denied:
    "the admin's assistant permissions do not cover it. This is a permissions decision, not a bug — an owner adjusts it in settings.",
  unavailable_for_auth_class:
    "Clockify does not allow this add-on to perform it. No rewording will help; it is a platform restriction.",
  host_call_budget_exceeded:
    "this run's Clockify call budget is spent. Suggest a narrower range rather than retrying.",
  presentation_limit_exceeded: "the change was too large to present for review. Suggest smaller pieces.",
  clarification_required: "it needs an answer from the admin before it can run.",
  clarification_already_active:
    "a question is already open and waiting on the admin. Do not ask a second one; wait for the answer.",
  write_port_not_ready: "the change could not be prepared for review. Report that; do not retry blindly.",
  read_failed: "the read did not complete. It may be worth one retry; do not treat it as an empty result.",
  read_dispatch_failed:
    "Clockify could not be reached for that read. It may be worth one retry; do not treat it as an empty result.",
  cancelled_before_dispatch: "the admin cancelled before it ran. Nothing happened.",
  not_admitted: "the run stopped before this call started. Nothing happened.",
  unexpected_action_result: "the result had a shape that could not be interpreted. Do not guess what it contained.",
  installation_changed: "the Clockify installation changed mid-run. Stop; the admin must reload.",
};

/** Deterministic model-visible lines. Data is quoted as data, never as instruction. */
export function formatObservations(observations: readonly RunObservation[]): string[] {
  return observations.map((observation) => {
    if (observation.kind === "result") return `${observation.actionName} returned: ${observation.summary}`;
    // An unmapped code says so rather than inviting a guess. "Explain the
    // refusal" with nothing to explain from is what produced the fabrication.
    const guidance = DENIAL_GUIDANCE[observation.code] ?? "no further detail is available for this code.";
    return `${observation.actionName} was refused (${observation.code}): ${guidance}`
      + " Do not repeat this call unchanged."
      + " If you tell the admin why, use THIS reason verbatim — do not invent a different explanation,"
      + " and do not state anything about which Clockify operations exist unless a search returned it.";
  });
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
