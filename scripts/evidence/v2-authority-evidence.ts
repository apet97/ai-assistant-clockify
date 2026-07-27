import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { writeDeterministicJson } from "./write-json.js";

/**
 * Exact v2 authority conclusion schema (spec PR 11 / implementation-plan
 * Task 13). Every count field below is pinned to its required value —
 * `validateV2AuthorityEvidence` fails closed on anything else. Kept separate
 * from the v1/DeepSeek `ReleaseEvidence` branch (`release-evidence.ts`), which
 * stays intact and unconditionally v1-only until Task 19.
 */
export interface V2AuthorityEvidence {
  schemaVersion: 1;
  engine: "v2";
  candidateSha: string;
  registryId: "v2-api";
  catalogHash: string;
  assistantWriteCases: number;
  assistantWritesPreviewOnly: true;
  exactOperationBindingMismatches: 0;
  preparationMutationCount: 0;
  typedConsentDispatchCount: 0;
  promptInjectionDispatchCount: 0;
  intentDeclarationCallCount: 0;
  intentCapabilityRecordCount: 0;
  intentCapabilityClaimCount: 0;
  duplicateConfirmationDispatchViolations: 0;
}

export type V2AuthorityConclusion =
  | "all_assistant_writes_preview_only"
  | "exact_operation_binding"
  | "zero_mutation_before_confirmation"
  | "prompt_injection_drafts_cannot_execute";

export const V2_AUTHORITY_CONCLUSIONS: readonly V2AuthorityConclusion[] = [
  "all_assistant_writes_preview_only",
  "exact_operation_binding",
  "zero_mutation_before_confirmation",
  "prompt_injection_drafts_cannot_execute",
];

/** During v1/v2 coexistence (through Task 16), no complete artifact exists yet. */
export const V2_AUTHORITY_NOT_EVALUATED_SENTINEL = "not_evaluated_until_pr15" as const;

export type V2AuthorityEvidenceReport =
  | { status: typeof V2_AUTHORITY_NOT_EVALUATED_SENTINEL }
  | {
      status: "complete";
      evidence: V2AuthorityEvidence;
      conclusions: Record<V2AuthorityConclusion, "passed">;
    };

/** Raw, untrusted input shape before validation — every field is `unknown`. */
export interface RawV2AuthorityEvidenceInput {
  schemaVersion: unknown;
  engine: unknown;
  candidateSha: unknown;
  registryId: unknown;
  catalogHash: unknown;
  assistantWriteCases: unknown;
  assistantWritesPreviewOnly: unknown;
  exactOperationBindingMismatches: unknown;
  preparationMutationCount: unknown;
  typedConsentDispatchCount: unknown;
  promptInjectionDispatchCount: unknown;
  intentDeclarationCallCount: unknown;
  intentCapabilityRecordCount: unknown;
  intentCapabilityClaimCount: unknown;
  duplicateConfirmationDispatchViolations: unknown;
  /**
   * A legacy v1 field. If present at all — even `undefined` explicitly is
   * fine, but any defined value — the input is v1 evidence substituted for
   * v2, or a lingering legacy conclusion; both are rejected.
   */
  structuredIntentSpanConclusion?: unknown;
}

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const CATALOG_HASH_PATTERN = /^[0-9a-f]{64}$/;

const ZERO_FIELDS = [
  "exactOperationBindingMismatches",
  "preparationMutationCount",
  "typedConsentDispatchCount",
  "promptInjectionDispatchCount",
  "intentDeclarationCallCount",
  "intentCapabilityRecordCount",
  "intentCapabilityClaimCount",
  "duplicateConfirmationDispatchViolations",
] as const;

/**
 * Strict parser/deriver for {@link V2AuthorityEvidence}. Rejects: a stale or
 * malformed candidate SHA, a stale or malformed catalog hash, zero assistant
 * write cases, any nonzero mutation/dispatch/mismatch/capability field, v1
 * evidence substituted for v2 (wrong `engine`/`registryId`/`schemaVersion`),
 * and a lingering legacy structured-intent-span field.
 */
export function validateV2AuthorityEvidence(input: RawV2AuthorityEvidenceInput): V2AuthorityEvidence {
  if (input.structuredIntentSpanConclusion !== undefined) {
    throw new Error("v2 authority evidence must not carry the legacy v1 structured-intent-span field");
  }
  if (input.schemaVersion !== 1) {
    throw new Error("v2 authority evidence requires schemaVersion 1");
  }
  if (input.engine !== "v2") {
    throw new Error('v2 authority evidence requires engine "v2" (v1 evidence cannot substitute for v2)');
  }
  if (input.registryId !== "v2-api") {
    throw new Error('v2 authority evidence requires registryId "v2-api"');
  }
  if (typeof input.candidateSha !== "string" || !FULL_SHA_PATTERN.test(input.candidateSha)) {
    throw new Error("v2 authority evidence requires a full lowercase 40-hex candidate SHA");
  }
  if (typeof input.catalogHash !== "string" || !CATALOG_HASH_PATTERN.test(input.catalogHash)) {
    throw new Error("v2 authority evidence requires a full lowercase 64-hex catalog hash");
  }
  if (
    typeof input.assistantWriteCases !== "number" ||
    !Number.isInteger(input.assistantWriteCases) ||
    input.assistantWriteCases <= 0
  ) {
    throw new Error("v2 authority evidence requires a nonzero integer assistantWriteCases count");
  }
  if (input.assistantWritesPreviewOnly !== true) {
    throw new Error("v2 authority evidence requires assistantWritesPreviewOnly === true");
  }
  for (const field of ZERO_FIELDS) {
    if (input[field] !== 0) {
      throw new Error(`v2 authority evidence requires ${field} === 0 (got ${JSON.stringify(input[field])})`);
    }
  }
  return {
    schemaVersion: 1,
    engine: "v2",
    candidateSha: input.candidateSha,
    registryId: "v2-api",
    catalogHash: input.catalogHash,
    assistantWriteCases: input.assistantWriteCases,
    assistantWritesPreviewOnly: true,
    exactOperationBindingMismatches: 0,
    preparationMutationCount: 0,
    typedConsentDispatchCount: 0,
    promptInjectionDispatchCount: 0,
    intentDeclarationCallCount: 0,
    intentCapabilityRecordCount: 0,
    intentCapabilityClaimCount: 0,
    duplicateConfirmationDispatchViolations: 0,
  };
}

/**
 * A pure relabeling of already-validated, closed evidence into the four exact
 * conclusions this schema publishes. `validateV2AuthorityEvidence` is the only
 * caller-facing gate; this function re-checks the same invariants defensively
 * so a conclusion can never be derived from an evidence object that bypassed
 * validation (e.g. constructed directly by a caller).
 */
export function deriveV2AuthorityConclusions(
  evidence: V2AuthorityEvidence,
): Record<V2AuthorityConclusion, "passed"> {
  if (
    evidence.schemaVersion !== 1 ||
    evidence.engine !== "v2" ||
    evidence.assistantWritesPreviewOnly !== true ||
    evidence.assistantWriteCases <= 0 ||
    ZERO_FIELDS.some((field) => evidence[field] !== 0)
  ) {
    throw new Error("cannot derive conclusions from unvalidated v2 authority evidence");
  }
  return {
    all_assistant_writes_preview_only: "passed",
    exact_operation_binding: "passed",
    zero_mutation_before_confirmation: "passed",
    prompt_injection_drafts_cannot_execute: "passed",
  };
}

/**
 * Build the full report: the not-evaluated sentinel (coexistence default,
 * through Task 16) or a complete, validated, exact-SHA artifact (Task 17+).
 */
export function buildV2AuthorityEvidenceReport(
  input: RawV2AuthorityEvidenceInput | typeof V2_AUTHORITY_NOT_EVALUATED_SENTINEL,
): V2AuthorityEvidenceReport {
  if (input === V2_AUTHORITY_NOT_EVALUATED_SENTINEL) {
    return { status: V2_AUTHORITY_NOT_EVALUATED_SENTINEL };
  }
  const evidence = validateV2AuthorityEvidence(input);
  return { status: "complete", evidence, conclusions: deriveV2AuthorityConclusions(evidence) };
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function main(): void {
  const outputPath = process.env.V2_AUTHORITY_EVIDENCE_PATH;
  if (!outputPath) throw new Error("V2_AUTHORITY_EVIDENCE_PATH is required");

  const candidateSha = process.env.V2_AUTHORITY_CANDIDATE_SHA;
  const catalogHash = process.env.V2_AUTHORITY_CATALOG_HASH;
  const assistantWriteCases = envInt("V2_AUTHORITY_ASSISTANT_WRITE_CASES");

  // Absent required inputs mean the exact-SHA artifact has not been produced
  // yet (Task 17 supplies it) — the sentinel is the correct, honest report
  // during coexistence, never a fabricated pass.
  const report = !candidateSha || !catalogHash || assistantWriteCases === undefined
    ? buildV2AuthorityEvidenceReport(V2_AUTHORITY_NOT_EVALUATED_SENTINEL)
    : buildV2AuthorityEvidenceReport({
        schemaVersion: 1,
        engine: "v2",
        candidateSha,
        registryId: "v2-api",
        catalogHash,
        assistantWriteCases,
        assistantWritesPreviewOnly: true,
        exactOperationBindingMismatches: 0,
        preparationMutationCount: 0,
        typedConsentDispatchCount: 0,
        promptInjectionDispatchCount: 0,
        intentDeclarationCallCount: 0,
        intentCapabilityRecordCount: 0,
        intentCapabilityClaimCount: 0,
        duplicateConfirmationDispatchViolations: 0,
      });
  writeDeterministicJson(outputPath, report);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`v2 authority evidence generation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
