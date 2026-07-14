import type { ListResult } from "../clockify/types.js";
import type { EntityRef } from "./receipts.js";
import { boundedSanitizedJson, sanitizeCompleteJson, sanitizeJson, sanitizedFingerprint } from "./safe-json.js";

export type ReconciliationStrategy = "create" | "update" | "delete" | "state-command" | "composed";

export interface ReconciliationBinding {
  operationId: string;
  stepId: string;
  actionName: string;
  actionFingerprint: string;
  catalogHash: string;
  planStepId?: string;
  strategy?: ReconciliationStrategy;
}

export interface ReconciliationCandidate {
  ref: EntityRef;
  projection: unknown;
}

export interface ReconciliationResult {
  authoritative: boolean;
  reason: string;
  binding: ReconciliationBinding;
  evidence: unknown;
}

/**
 * Generic, deliberately read-only reconciliation. Its callback surface can only
 * return evidence; it contains no dispatch or compensation capability.
 */
export async function reconcileExternalMutation(input: {
  strategy: ReconciliationStrategy;
  binding: ReconciliationBinding;
  expected: { actionFingerprint: string; catalogHash: string };
  readEvidence(): Promise<ListResult<ReconciliationCandidate>>;
  matches(candidate: ReconciliationCandidate): boolean;
}): Promise<ReconciliationResult> {
  const base = { binding: input.binding };
  if (input.binding.strategy !== undefined && input.binding.strategy !== input.strategy) {
    return { ...base, authoritative: false, reason: "binding_mismatch", evidence: { compatible: false } };
  }
  if (input.expected.actionFingerprint !== input.binding.actionFingerprint) {
    return { ...base, authoritative: false, reason: "action_fingerprint_drift", evidence: { compatible: false } };
  }
  if (input.expected.catalogHash !== input.binding.catalogHash) {
    return { ...base, authoritative: false, reason: "catalog_hash_drift", evidence: { compatible: false } };
  }

  let rows: ListResult<ReconciliationCandidate>;
  try {
    rows = await input.readEvidence();
  } catch {
    return { ...base, authoritative: false, reason: "read_failed", evidence: { complete: false } };
  }
  if (!rows || !Array.isArray(rows.rows) || typeof rows.truncated !== "boolean") {
    return { ...base, authoritative: false, reason: "invalid_evidence", evidence: { complete: false } };
  }
  if (rows.truncated) {
    return { ...base, authoritative: false, reason: "incomplete_evidence", evidence: { complete: false } };
  }
  const safeRows: ReconciliationCandidate[] = [];
  for (const row of rows.rows) {
    if (!row || typeof row !== "object" || !Object.hasOwn(row, "projection") || !row.ref || typeof row.ref !== "object") {
      return { ...base, authoritative: false, reason: "invalid_evidence", evidence: { complete: true } };
    }
    const rawRef = row.ref as unknown as Record<string, unknown>;
    if (typeof rawRef.type !== "string" || rawRef.type.length === 0 || rawRef.type.length > 256 ||
      typeof rawRef.id !== "string" || rawRef.id.length === 0 || rawRef.id.length > 256) {
      return { ...base, authoritative: false, reason: "invalid_evidence", evidence: { complete: true } };
    }
    const safeRef = sanitizeJson(row.ref);
    if (!safeRef || typeof safeRef !== "object") {
      return { ...base, authoritative: false, reason: "invalid_evidence", evidence: { complete: true } };
    }
    safeRows.push({
      ref: safeRef as EntityRef,
      projection: sanitizeCompleteJson(row.projection),
    });
  }
  let matches: ReconciliationCandidate[];
  try {
    matches = safeRows.filter((row) => input.matches(row));
  } catch {
    return { ...base, authoritative: false, reason: "evaluation_failed", evidence: { complete: true } };
  }
  const authoritative = input.strategy === "delete" ? matches.length === 0 : matches.length === 1;
  const evidence = boundedSanitizedJson({
    complete: true,
    rowCount: safeRows.length,
    matchCount: matches.length,
    candidates: matches.map((candidate) => ({
      ref: candidate.ref,
      fingerprint: sanitizedFingerprint(candidate.projection),
    })),
  }, 60_000);
  return {
    ...base,
    authoritative,
    reason: authoritative ? "authoritative_match" : "non_unique_or_missing",
    evidence,
  };
}
