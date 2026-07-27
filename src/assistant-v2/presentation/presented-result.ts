import { z } from "zod";
import { PUBLIC_FACT_LIMIT } from "../../harness/prepared-write-presentation.js";
import { TOOL_RESULT_MAX_BYTES } from "../../assistant/tool-results.js";

/**
 * The ONE authoritative v2 result envelope (T15-A). `PresentedResult` /
 * `DiagnosticView` / `PresentedResultEnvelope` are defined here and nowhere
 * else — `events.ts` re-exports them so every existing import path
 * (`../assistant-v2/events.js`, `../shared/contracts.js`) is unchanged. Do
 * not add a second envelope type anywhere in the v2 tree.
 *
 * Everything the server derives lives in `presentation`: status, title,
 * summary, facts, warnings, references, recovery. None of it is a live
 * control. The ONLY live control on the whole envelope is the transient,
 * freshly-rotated `confirmation` block (id/nonce/expiresAt) attached solely
 * to a `pending_confirmation` attachment — it is never persisted in plaintext
 * (`rotatePendingNonce` recomputes it per serve from a stored hash; see
 * `src/services/run-event-hydration.ts`). `presentedResultSchema` itself has
 * no nonce-shaped field at all, and `diagnostic.value` is the sanitized
 * canonical receipt — canonical `action_results` rows never carry a nonce to
 * begin with, so there is nothing to redact there by construction.
 */

export const PRESENTED_RESULT_STATUSES = [
  "succeeded",
  "failed",
  "partial",
  "pending_confirmation",
  "cancelled",
  "outcome_unknown",
] as const;

export type PresentedResultStatus = (typeof PRESENTED_RESULT_STATUSES)[number];

/** Canonical bounds (T15-A). Facts reuse Task 11's exact public-fact ceiling
 * (`PUBLIC_FACT_LIMIT` in `prepared-write-presentation.ts` — 22 material facts
 * plus the 2 `toPublicPresentationFacts` always appends: API endpoint,
 * Reversibility) so a presenter (T15-B) can never emit more facts than a
 * prepared write could ever mechanically expand. */
export const PRESENTED_RESULT_MAX_FACTS = PUBLIC_FACT_LIMIT;
export const PRESENTED_RESULT_MAX_WARNINGS = 12;
export const PRESENTED_RESULT_MAX_REFERENCES = 12;
export const PRESENTED_RESULT_TITLE_MAX_CHARS = 512;
export const PRESENTED_RESULT_SUMMARY_MAX_CHARS = 4_096;
export const PRESENTED_RESULT_FACT_LABEL_MAX_CHARS = 256;
export const PRESENTED_RESULT_FACT_VALUE_MAX_CHARS = 2_048;
export const PRESENTED_RESULT_WARNING_MAX_CHARS = 256;
export const PRESENTED_RESULT_STRING_ID_MAX_CHARS = 256;
export const PRESENTED_RESULT_DISPLAY_NAME_MAX_CHARS = 512;
/** DiagnosticView reuses the model-facing tool-result byte budget — the
 * diagnostic value is the same sanitized canonical receipt shape, so it needs
 * no separate bound. */
export const DIAGNOSTIC_VALUE_MAX_BYTES = TOOL_RESULT_MAX_BYTES;

const jsonValueSchema: z.ZodType<JsonValueLike> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(jsonValueSchema), z.record(jsonValueSchema)]),
);
type JsonValueLike = null | boolean | number | string | JsonValueLike[] | { [key: string]: JsonValueLike };

const factSchema = z
  .object({
    label: z.string().max(PRESENTED_RESULT_FACT_LABEL_MAX_CHARS),
    value: z.string().max(PRESENTED_RESULT_FACT_VALUE_MAX_CHARS),
  })
  .strict();

const warningSchema = z
  .object({
    code: z.string().max(PRESENTED_RESULT_STRING_ID_MAX_CHARS),
    message: z.string().max(PRESENTED_RESULT_WARNING_MAX_CHARS),
  })
  .strict();

const referenceSchema = z
  .object({
    id: z.string().max(PRESENTED_RESULT_STRING_ID_MAX_CHARS),
    conversationId: z.string().max(PRESENTED_RESULT_STRING_ID_MAX_CHARS),
    entityType: z.string().max(PRESENTED_RESULT_STRING_ID_MAX_CHARS),
    externalId: z.string().max(PRESENTED_RESULT_STRING_ID_MAX_CHARS),
    displayName: z.string().max(PRESENTED_RESULT_DISPLAY_NAME_MAX_CHARS),
    sourceRunId: z.string().max(PRESENTED_RESULT_STRING_ID_MAX_CHARS),
    bindings: z.record(z.string()),
    status: z.enum(["active", "stale", "deleted"]),
    verifiedAt: z.string(),
  })
  .strict();

const recoverySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("view_operation"), label: z.string(), operationId: z.string() }).strict(),
  z.object({ kind: z.literal("retry_read"), label: z.string(), readAttemptId: z.string() }).strict(),
  z.object({ kind: z.literal("start_new_chat"), label: z.string() }).strict(),
]);

/** Strict runtime shape for `PresentedResult`. Rejects any unknown key at
 * every level, so a field added elsewhere without updating this schema fails
 * loudly instead of silently passing through. */
export const presentedResultSchema = z
  .object({
    status: z.enum(PRESENTED_RESULT_STATUSES),
    title: z.string().max(PRESENTED_RESULT_TITLE_MAX_CHARS),
    summary: z.string().max(PRESENTED_RESULT_SUMMARY_MAX_CHARS),
    facts: z.array(factSchema).max(PRESENTED_RESULT_MAX_FACTS),
    warnings: z.array(warningSchema).max(PRESENTED_RESULT_MAX_WARNINGS),
    references: z.array(referenceSchema).max(PRESENTED_RESULT_MAX_REFERENCES),
    recovery: recoverySchema.optional(),
  })
  .strict();

export type PresentedResult = z.infer<typeof presentedResultSchema>;

export const diagnosticViewSchema = z
  .object({
    kind: z.literal("sanitized_receipt"),
    byteLength: z.number().int().nonnegative().max(DIAGNOSTIC_VALUE_MAX_BYTES),
    value: jsonValueSchema,
  })
  .strict()
  .refine((diagnostic) => Buffer.byteLength(JSON.stringify(diagnostic.value ?? null), "utf8") === diagnostic.byteLength, {
    message: "diagnostic byteLength must match the exact UTF-8 length of value",
  });

export type DiagnosticView = z.infer<typeof diagnosticViewSchema>;

export const presentedResultEnvelopeSchema = z
  .object({
    presentation: presentedResultSchema,
    actionResultId: z.string().max(PRESENTED_RESULT_STRING_ID_MAX_CHARS).optional(),
    confirmation: z
      .object({
        id: z.string().max(PRESENTED_RESULT_STRING_ID_MAX_CHARS),
        nonce: z.string(),
        expiresAt: z.string(),
      })
      .strict()
      .optional(),
    undo: z.object({ id: z.string().max(PRESENTED_RESULT_STRING_ID_MAX_CHARS) }).strict().optional(),
    diagnostic: diagnosticViewSchema.optional(),
  })
  .strict();

export type PresentedResultEnvelope = z.infer<typeof presentedResultEnvelopeSchema>;

/** Parse and validate an unknown value as a `PresentedResultEnvelope`,
 * rejecting unknown keys, an unrecognized status, or an out-of-bound field.
 * Throws a `ZodError` on failure (callers decide how to surface it). */
export function decodePresentedResultEnvelope(value: unknown): PresentedResultEnvelope {
  return presentedResultEnvelopeSchema.parse(value);
}

/** Verification helper (used by tests, not the request path): proves
 * `presentation` — the server-derived descriptive content — carries no
 * nonce/secret-shaped field at any depth, and that `undo` never grows beyond
 * its one `id`. `presentedResultSchema`'s own `.strict()` shape already
 * rejects an unknown key there by construction; this walks a DECODED value
 * defensively so a future schema edit that reintroduces one fails a real
 * assertion, not just a type-level absence.
 *
 * Deliberately does NOT walk `confirmation` (the one legitimate, transient,
 * per-serve-rotated live control) or `diagnostic.value` (arbitrary sanitized
 * Clockify receipt JSON — a real entity field named e.g. "token" would false
 * positive here; that value's redaction, if ever needed, is a receipt-layer
 * concern, not this envelope-shape concern). */
export function assertNoStrayLiveControl(envelope: PresentedResultEnvelope): void {
  const suspect = /nonce|secret|token|password|credential/iu;
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (suspect.test(key)) throw new Error(`stray_live_control_field:${path}.${key}`);
      walk(child, `${path}.${key}`);
    }
  };
  walk(envelope.presentation, "envelope.presentation");
  if (envelope.undo) walk(envelope.undo, "envelope.undo");
}
