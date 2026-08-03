/**
 * The closed set of reasons a v2 run can end without a reply, and the admin-facing
 * sentence for each.
 *
 * Two things forced this to be a type rather than a string. An internal enum was
 * rendered verbatim to an admin ("Assistant run failed: too_many_refinements"), and
 * separate sites could put an arbitrary caught `error.message` in the same field —
 * the class of value commit 75a87a8 proved carries admin-authored text,
 * workspace-id fragments and JWT prefixes.
 *
 * The site inventory, derived from `git log -p ef0bd03..HEAD` rather than from
 * prose, because this file's own header and the branch's commit messages named
 * DIFFERENT fourth sites — and that unpinned inventory is precisely how the
 * fifth and sixth went unnoticed:
 *   1. `runner.ts` — a failed model call, into `failRun`.
 *   2. `action-execution-service.ts` — a failed read dispatch.
 *   3. `action-execution-service.ts` — a thrown write-preparation cause
 *      appended to the denial code.
 *   4. `action-execution-service.ts` — the not-admitted tail.
 *   5. `routes/v2-chat-pipeline.ts` — the free-text clarification continuation,
 *      into the ROUTE-level `code` field, which never passes through
 *      `asTerminalReason` and so survived the original sweep.
 *   6. `services/operation-preparation-service.ts` — the raw message as BOTH
 *      the receipt code and the receipt message. The only one of the six that
 *      was rendered straight onto an admin's result card.
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
 * That last source is NOT closed at the type level: `receipt.code` is `string`, and
 * the receipt producers in `src/harness` are open by construction — many build the
 * code from a variable, so no count of them is reproducible and none is asserted
 * here. (A previous revision claimed 85. Counting literal `code: "…"` gives 78,
 * which is a floor, not a measurement: 19 non-literal `code:` arguments and 199
 * `errorReceipt`/`listReceipt` call sites sit outside any such regex.)
 *
 * The one figure that IS reproducible, with the command that reproduces it:
 *   `operation-preparation-service.ts` admits an open `invalid_*` prefix family;
 *   `grep -rhoE '"invalid_[a-z0-9_]+"' src | sort -u | wc -l` → 35.
 *
 * Enumerating those would be noise; `asTerminalReason` is therefore load-bearing
 * rather than decorative — it is what makes the admin-facing field closed despite a
 * producer that types cannot close.
 *
 * `tests/unit/terminal-reason.test.ts` pins the codes those producers reach this
 * field with today, and derives the producer set from SOURCE so a new LITERAL code
 * fails the build instead of silently degrading. Its own comment states what that
 * extraction cannot see.
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
  | "read_dispatch_failed"
  | "invalid_request"
  | "cancelled_before_dispatch"
  | "not_admitted"
  | "read_failed"
  | "clarification_already_active"
  | "unexpected_action_result";

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
  "invalid_request",
  "cancelled_before_dispatch",
  "not_admitted",
  "read_failed",
  "clarification_already_active",
  "unexpected_action_result",
] as const;

/**
 * T12: typed replacement for the bare `Error("installation_changed")` that
 * `requestGovernorFor` (`src/routes/v2-chat-pipeline.ts`) throws when a read's
 * per-dispatch generation recheck (F07) finds the installation no longer
 * current. Consumers that can import this module should `instanceof`-check
 * it rather than compare `error.message` to a magic string.
 *
 * `code` is kept equal to the `TerminalReason` literal so sites that only
 * look at a DECLARED `code` property (the "declared code beats prose
 * message" pattern already used for `HostCallBudgetExceededError` etc. in
 * `read-execution.ts`) keep working without a code change on their part.
 */
export class InstallationChangedError extends Error {
  readonly code: Extract<TerminalReason, "installation_changed"> = "installation_changed";
  constructor() {
    super("installation_changed");
    this.name = "InstallationChangedError";
  }
}

/**
 * Parse at the boundary. An unrecognized reason — including a raw error message that
 * reached this field before the runner was fixed, and any future `invalid_*` code the
 * preparation service invents — becomes `internal_error` rather than being shown.
 * Never widen this to pass the input through.
 */
export function asTerminalReason(raw: string): TerminalReason {
  if ((TERMINAL_REASONS as readonly string[]).includes(raw)) return raw as TerminalReason;
  // `operation-preparation-service.ts:475` denies on `code.startsWith("invalid_")`,
  // an OPEN family: 35 distinct `invalid_*` codes exist in `src/` today and
  // nothing stops a 36th. Enumerating them would add 35 near-identical
  // sentences, but collapsing them to `internal_error` tells the admin
  // something went wrong on OUR side when the request itself was malformed —
  // a false attribution that sends them to support instead of to their own
  // wording. They share one honest sentence instead.
  //
  // Safe against a hostile message that merely starts with those bytes: the
  // result is still a constant, never the input.
  if (raw.startsWith("invalid_")) return "invalid_request";
  return "internal_error";
}

/**
 * Total. The `never` binding fails compilation if a member has no copy.
 *
 * `internal_error` serves double duty: a reason the runner names itself, and the
 * fallback `asTerminalReason` returns for anything unrecognized that is not
 * `invalid_*`. Its sentence is written to read correctly for both.
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
    case "invalid_request":
      return "I could not build a valid request for what you asked, so I stopped rather than send it. Nothing was changed. Try rephrasing with the specific details you want.";
    case "cancelled_before_dispatch":
      return "That request was cancelled before this step started, so it never ran. Nothing was changed.";
    case "not_admitted":
      return "I stopped partway through and did not start the remaining steps. Nothing was changed. Please try again.";
    case "read_dispatch_failed":
      return "I could not read from Clockify to finish that request. Nothing was changed. Please try again in a moment.";
    case "read_failed":
      return "A read from Clockify did not complete, so I stopped. Nothing was changed. Please try again in a moment.";
    case "clarification_already_active":
      return "I already have an open question waiting on your answer, so I stopped rather than ask a second one. Nothing was changed. Answer the question above and I will carry on.";
    case "unexpected_action_result":
      return "An operation returned something I could not interpret, so I stopped rather than act on it. Nothing was changed. Please try again.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
