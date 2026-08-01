/**
 * The closed set of reasons a v2 run can end without a reply, and the admin-facing
 * sentence for each.
 *
 * Two things forced this to be a type rather than a string. An internal enum was
 * rendered verbatim to an admin ("Assistant run failed: too_many_refinements"), and
 * two separate sites could put an arbitrary caught `error.message` in the same field
 * (`runner.ts` on a failed model call, `action-execution-service.ts` on a failed read
 * dispatch) — the class of value commit 75a87a8 proved carries admin-authored text,
 * workspace-id fragments and JWT prefixes.
 *
 * `copyFor` is total over `TerminalReason`. Adding a member without copy is a compile
 * error, which is the point: the next reason cannot ship as a raw enum.
 *
 * The members come from four measured sources, not from guesswork:
 *   - the terminal reasons `runner.ts` names itself,
 *   - `ProviderProtocolErrorReason` (`assistant/model-client.ts:104`), reached via
 *     `runner.ts:191`,
 *   - the `denyCode` union (`services/action-execution-service.ts:38`), and
 *   - the denial codes propagated by `api-discovery-service.ts`,
 *     `operation-preparation-service.ts` and `read-execution.ts`, which reach the
 *     same field through `lastDenialCode`.
 *
 * That last source is NOT closed at the type level: `receipt.code` is `string` and
 * `operation-preparation-service.ts:475` admits an open `invalid_*` prefix family.
 * `asTerminalReason` is therefore load-bearing rather than decorative — it is what
 * makes the admin-facing field closed despite an open producer.
 */
export type TerminalReason =
  | "cancelled"
  | "duplicate_write"
  | "installation_changed"
  | "internal_error"
  | "missing_original_request"
  | "model_failed"
  | "no_progress"
  | "budget_exhausted"
  | "unoffered_tool"
  | "malformed_tool"
  | "malformed_completion"
  | "tool_not_loaded"
  | "stale_catalog_hash"
  | "unknown_tool"
  | "unavailable_for_auth_class"
  | "duplicate_tool_call_id"
  | "mixed_discovery_batch"
  | "read_write_dependency"
  | "too_many_refinements"
  | "write_port_not_ready"
  | "invalid_args"
  | "unknown_action"
  | "policy_denied"
  | "host_call_budget_exceeded"
  | "clarification_required"
  | "presentation_limit_exceeded"
  | "read_dispatch_failed";

/** Every reason, for exhaustiveness tests. Keep in sync with the union above. */
export const TERMINAL_REASONS: readonly TerminalReason[] = [
  "cancelled",
  "duplicate_write",
  "installation_changed",
  "internal_error",
  "missing_original_request",
  "model_failed",
  "no_progress",
  "budget_exhausted",
  "unoffered_tool",
  "malformed_tool",
  "malformed_completion",
  "tool_not_loaded",
  "stale_catalog_hash",
  "unknown_tool",
  "unavailable_for_auth_class",
  "duplicate_tool_call_id",
  "mixed_discovery_batch",
  "read_write_dependency",
  "too_many_refinements",
  "write_port_not_ready",
  "invalid_args",
  "unknown_action",
  "policy_denied",
  "host_call_budget_exceeded",
  "clarification_required",
  "presentation_limit_exceeded",
  "read_dispatch_failed",
] as const;

/**
 * Parse at the boundary. An unrecognized reason — including a raw error message that
 * reached this field before the runner was fixed, and any future `invalid_*` code the
 * preparation service invents — becomes `internal_error` rather than being shown.
 * Never widen this to pass the input through.
 */
export function asTerminalReason(raw: string): TerminalReason {
  return (TERMINAL_REASONS as readonly string[]).includes(raw)
    ? (raw as TerminalReason)
    : "internal_error";
}

/**
 * Total. The `never` binding fails compilation if a member has no copy.
 *
 * `internal_error` serves double duty: a reason the runner names itself, and the
 * fallback `asTerminalReason` returns for anything unrecognized. Its sentence is
 * written to read correctly for both.
 */
export function copyFor(reason: TerminalReason): string {
  switch (reason) {
    case "cancelled":
      return "That request was cancelled before it finished. Nothing was changed.";
    case "duplicate_write":
      return "That same change had already been requested in this conversation, so I stopped rather than repeat it. Nothing new was changed.";
    case "installation_changed":
      return "This workspace's add-on installation changed while I was working, so I stopped. Nothing was changed. Reload the assistant and try again.";
    case "internal_error":
      return "Something went wrong on my side, so I stopped. Nothing was changed. Please try again, and tell support if it keeps happening.";
    case "missing_original_request":
      return "I could not find the original request to carry on from, so I stopped. Nothing was changed. Please ask again in a new message.";
    case "model_failed":
      return "I could not reach the assistant model to finish that request. Nothing was changed. Please try again in a moment.";
    case "no_progress":
      return "I stopped because I was repeating the same step without making progress. Nothing was changed.";
    case "budget_exhausted":
      return "That request needed more steps than a single run allows, so I stopped. Nothing was changed. Try asking for one thing at a time.";
    case "unoffered_tool":
      return "The assistant model tried to use an operation I had not offered it, so I stopped rather than run it. Nothing was changed.";
    case "malformed_tool":
      return "The assistant model asked for an operation in a form I could not read, so I stopped rather than act on it. Nothing was changed. Please try again.";
    case "malformed_completion":
      return "The assistant model returned a reply I could not read, so I stopped. Nothing was changed. Please try again.";
    case "tool_not_loaded":
      return "I tried to use a Clockify operation I had not loaded yet, so I stopped instead of guessing. Nothing was changed. Please try again.";
    case "stale_catalog_hash":
      return "The set of available Clockify operations changed while I was working, so I stopped. Nothing was changed. Please try again.";
    case "unknown_tool":
      return "I tried to use a Clockify operation that does not exist, so I stopped. Nothing was changed. Please rephrase what you need.";
    case "unavailable_for_auth_class":
      return "Clockify does not allow this add-on to perform that operation, so I stopped. Nothing was changed.";
    case "duplicate_tool_call_id":
      return "The assistant model repeated a step in a way I could not act on safely, so I stopped. Nothing was changed. Please try again.";
    case "mixed_discovery_batch":
      return "The assistant model tried to search and act in the same step, which I do not allow, so I stopped. Nothing was changed. Please try again.";
    case "read_write_dependency":
      return "I was asked to make a change based on something I had not read yet, so I stopped. Nothing was changed. Please try again.";
    case "too_many_refinements":
      return "I ran out of searches while looking for the right Clockify operation, so I stopped instead of guessing. Nothing was changed. Starting a new chat resets the search budget.";
    case "write_port_not_ready":
      return "I could not prepare that change for your review, so I stopped. Nothing was changed. Please try again.";
    case "invalid_args":
      return "I could not put together a valid request for that operation, so I stopped. Nothing was changed. Please add the missing details and ask again.";
    case "unknown_action":
      return "I tried to use an operation that does not exist, so I stopped. Nothing was changed. Please rephrase what you need.";
    case "policy_denied":
      return "Your assistant permissions do not cover that, so I stopped. Nothing was changed. An owner can adjust your assistant permissions in settings.";
    case "host_call_budget_exceeded":
      return "That request needed more calls to Clockify than a single run allows, so I stopped. Nothing was changed. Try narrowing it to a smaller range.";
    case "clarification_required":
      return "I needed you to choose between a few options before I could carry on, and the run ended first. Nothing was changed. Please ask again.";
    case "presentation_limit_exceeded":
      return "That change was too large for me to show you for review, so I stopped. Nothing was changed. Try it in smaller pieces.";
    case "read_dispatch_failed":
      return "I could not read from Clockify to finish that request. Nothing was changed. Please try again in a moment.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
