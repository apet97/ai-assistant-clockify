import type { ListResult } from "../clockify/types.js";
import type { TargetSnapshot } from "./action.js";
import type { EntityRef } from "./receipts.js";
import { boundedSanitizedJson, sanitizeCompleteJson, sanitizedFingerprint } from "./safe-json.js";

export function captureTargetSnapshot(
  relation: TargetSnapshot["relation"],
  ref: EntityRef,
  projection: unknown,
): TargetSnapshot {
  const safeProjection = boundedSanitizedJson(projection);
  return {
    relation,
    ref: { ...ref },
    projection: safeProjection,
    fingerprint: sanitizedFingerprint(projection),
  };
}

type ResolveFailureCode = "target_not_found" | "target_evidence_incomplete" | "target_ambiguous";

export type AuthoritativeTargetResolution<T> =
  | { ok: true; ref: EntityRef; row: T; projection: unknown }
  | { ok: false; code: ResolveFailureCode; message: string };

const DIRECT_ID = /^[a-f0-9]{24}$/i;

/**
 * Resolve admin-authored identity without treating id-looking syntax as proof.
 * A direct id is fetched; a name search must be complete and exactly unique.
 */
export async function resolveAuthoritativeTarget<T>(input: {
  requested: string;
  type: string;
  fetchById(id: string): Promise<T | undefined>;
  searchByName(name: string): Promise<ListResult<T>>;
  project(row: T): { id: string; name?: string; projection?: unknown };
}): Promise<AuthoritativeTargetResolution<T>> {
  if (DIRECT_ID.test(input.requested)) {
    const row = await input.fetchById(input.requested);
    if (!row) return { ok: false, code: "target_not_found", message: "The requested target does not exist." };
    const projected = input.project(row);
    if (!projected.id || projected.id !== input.requested) {
      return { ok: false, code: "target_not_found", message: "The requested target could not be verified." };
    }
    return {
      ok: true,
      row,
      ref: { type: input.type, id: projected.id, ...(projected.name ? { name: projected.name } : {}) },
      projection: sanitizeCompleteJson(projected.projection ?? projected),
    };
  }

  const found = await input.searchByName(input.requested);
  if (found.truncated) {
    return { ok: false, code: "target_evidence_incomplete", message: "Clockify returned an incomplete target list." };
  }
  const normalizedName = (value: string): string => value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  const exact = found.rows.filter((row) => {
    const name = input.project(row).name;
    return typeof name === "string" && normalizedName(name) === normalizedName(input.requested);
  });
  if (exact.length === 0) return { ok: false, code: "target_not_found", message: "The requested target does not exist." };
  if (exact.length !== 1) return { ok: false, code: "target_ambiguous", message: "The requested target is not unique." };
  const row = exact[0]!;
  const projected = input.project(row);
  if (!projected.id) return { ok: false, code: "target_not_found", message: "The requested target could not be verified." };
  return {
    ok: true,
    row,
    ref: { type: input.type, id: projected.id, ...(projected.name ? { name: projected.name } : {}) },
    projection: sanitizeCompleteJson(projected.projection ?? projected),
  };
}

export type SnapshotVerification =
  | { ok: true }
  | {
      ok: false;
      code: "stale_target" | "stale_parent";
      message: string;
      requiresFreshPreview: true;
    };

/** Re-fetch and compare every ordered snapshot immediately before dispatch. */
export async function verifyTargetSnapshots(
  snapshots: readonly TargetSnapshot[],
  fetch: (snapshot: TargetSnapshot) => Promise<{ ref: EntityRef; projection?: unknown; truncated?: boolean } | undefined>,
): Promise<SnapshotVerification> {
  if (snapshots.length === 0) {
    return {
      ok: false,
      code: "stale_target",
      message: "The target could not be verified. Create a fresh preview.",
      requiresFreshPreview: true,
    };
  }
  for (const snapshot of snapshots) {
    let evidence: { ref: EntityRef; projection?: unknown; truncated?: boolean } | undefined;
    try {
      evidence = await fetch(snapshot);
    } catch {
      evidence = undefined;
    }
    const stale = !evidence || evidence.truncated === true || !Object.hasOwn(evidence, "projection") ||
      evidence.ref.type !== snapshot.ref.type || evidence.ref.id !== snapshot.ref.id ||
      sanitizedFingerprint(evidence.projection) !== snapshot.fingerprint;
    if (stale) {
      const code = snapshot.relation === "parent" ? "stale_parent" : "stale_target";
      return {
        ok: false,
        code,
        message: snapshot.relation === "parent"
          ? "The target parent changed or could not be verified. Create a fresh preview."
          : "The target changed or could not be verified. Create a fresh preview.",
        requiresFreshPreview: true,
      };
    }
  }
  return { ok: true };
}
