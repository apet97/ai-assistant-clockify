import type { ActionDefinition } from "../harness/action.js";
import {
  getPreparedWritePresenter,
  type FieldProvenanceMap,
  type JsonObject,
  type PreparedWritePresentation,
  type ResolvedTargetView,
  type ServerDefaultView,
} from "../harness/prepared-write-presentation.js";
import { presentedFactsFromPreparedWrite } from "../assistant-v2/presentation/presenter-registry.js";
import type { PresentedResult } from "../assistant-v2/presentation/presented-result.js";

/**
 * T15-B: the seam T15-C (read presenters) and T15-D (write terminal
 * presenters) build on. `presentPendingWriteConfirmation` renders a
 * `pending_confirmation` `PresentedResult` from a prepared write's stored
 * preview state — the four inputs are exactly what
 * `OperationPreparationService` already persists per operation (T11-C's
 * `operation`/`plan`/`targets`/`provenance` rows). This service does not
 * read the store itself; wiring a real DB read is T15-D's job, done one
 * domain family at a time per the plan's own process note.
 */

export interface PresentPreparedWriteInput {
  definition: ActionDefinition;
  normalizedOperation: JsonObject;
  fieldProvenance: FieldProvenanceMap;
  resolvedTargets: readonly ResolvedTargetView[];
  serverDefaults: readonly ServerDefaultView[];
}

/** Render a PENDING CONFIRMATION presentation from a prepared write's stored
 * preview state ("a pending confirmation renders from the stored preview" —
 * T15-D). Throws if the action is not `api`-exposed or has no registered
 * presenter (both indicate a caller error, not a runtime data condition). */
export function presentPendingWriteConfirmation(input: PresentPreparedWriteInput): PresentedResult {
  const action = input.definition;
  if (action.apiExposure !== "api" || !action.presentation) {
    throw new Error(`not_presentable:${action.name}`);
  }
  const presenter = getPreparedWritePresenter(action.presentation.presenterId);
  if (!presenter) throw new Error(`missing_presenter:${action.name}:${action.presentation.presenterId}`);
  const rendered: PreparedWritePresentation = presenter.presentPreparedWrite(input);
  return {
    status: "pending_confirmation",
    title: rendered.title,
    summary: rendered.reversibility.explanation,
    facts: presentedFactsFromPreparedWrite(rendered),
    warnings: rendered.warnings,
    references: [],
  };
}

// --- T15-C: read presenters -------------------------------------------------

/** Provider-supplied read summary bound (T15-C): "only a sanitized summary,
 * capped at the last valid UTF-8 boundary within 4,096 bytes." */
export const PROVIDER_SUMMARY_MAX_BYTES = 4_096;

/** Cap a provider-supplied summary string at `PROVIDER_SUMMARY_MAX_BYTES`,
 * never splitting a UTF-8 multi-byte sequence. Deterministic: the same input
 * always caps to the same output. */
export function sanitizeProviderSummary(rawSummary: string | undefined): { summary: string; truncated: boolean } {
  if (!rawSummary) return { summary: "", truncated: false };
  const bytes = Buffer.from(rawSummary, "utf8");
  if (bytes.byteLength <= PROVIDER_SUMMARY_MAX_BYTES) return { summary: rawSummary, truncated: false };
  let end = PROVIDER_SUMMARY_MAX_BYTES;
  // Walk back off any UTF-8 continuation byte (10xxxxxx) so the cut never
  // lands mid-character.
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return { summary: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

export interface PresentReadResultInput {
  title: string;
  /** Untrusted provider prose. Contributes ONLY to `summary` (capped/sanitized
   * here) — never to status, facts, warnings, or references. */
  providerSummary?: string;
  facts?: PresentedResult["facts"];
  warnings?: PresentedResult["warnings"];
  references?: PresentedResult["references"];
}

/**
 * Render a read result. The server derives status (always `succeeded` — a
 * read either returns canonical data or throws before this is ever called;
 * there is no partial/pending/cancelled/outcome_unknown state for a read),
 * `facts`, `warnings`, and `references` from `input` — the caller's canonical
 * result state, never the provider. The provider's ONLY contribution is
 * `providerSummary`, sanitized and byte-capped; when it was truncated a
 * deterministic `summary_truncated` warning is appended so the admin knows
 * the shown text is not complete.
 */
export function presentReadResult(input: PresentReadResultInput): PresentedResult {
  const { summary, truncated } = sanitizeProviderSummary(input.providerSummary);
  const warnings = [...(input.warnings ?? [])];
  if (truncated) {
    warnings.push({ code: "summary_truncated", message: "The summary was shortened to fit the size limit." });
  }
  return {
    status: "succeeded",
    title: input.title,
    summary,
    facts: input.facts ?? [],
    warnings,
    references: input.references ?? [],
  };
}

/**
 * Prove every confirmed material pointer present in the PREVIEW fact list
 * survives into the TERMINAL fact list with the SAME label and the SAME
 * value ("confirmed facts may never be removed or changed" — T15-D). A
 * terminal presentation may ADD response-only facts (present only in
 * `terminalFacts`); it must never drop or alter a confirmed one.
 */
export function assertPreviewTerminalFactParity(
  previewFacts: PresentedResult["facts"],
  terminalFacts: PresentedResult["facts"],
): void {
  const terminalByLabel = new Map(terminalFacts.map((fact) => [fact.label, fact.value]));
  for (const fact of previewFacts) {
    if (!terminalByLabel.has(fact.label)) throw new Error(`confirmed_fact_dropped:${fact.label}`);
    if (terminalByLabel.get(fact.label) !== fact.value) throw new Error(`confirmed_fact_changed:${fact.label}`);
  }
}
