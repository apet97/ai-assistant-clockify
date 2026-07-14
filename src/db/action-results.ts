export const ACTION_RESULT_SUMMARY_MAX_BYTES = 65_536;

export type ActionResultKind =
  | "succeeded"
  | "partial"
  | "definitive_failed"
  | "outcome_unknown";

export interface ActionResultRef {
  id: string;
  kind: ActionResultKind;
  summary: unknown;
}

const jsonBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

function jsonClone(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("action_result_not_json");
  return JSON.parse(encoded) as unknown;
}

function replaceData(value: unknown, actionResultId: string): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceData(item, actionResultId));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] = key === "data"
      ? {
          actionResultId,
          originalByteCount: jsonBytes(child),
        }
      : replaceData(child, actionResultId);
  }
  return result;
}

const criticalKey = (key: string): boolean =>
  [
    "kind",
    "receipt",
    "ok",
    "action",
    "status",
    "changed",
    "warnings",
    "error",
    "recovery",
    "message",
    "code",
    "outcome",
    "data",
    "ids",
  ].includes(key) || /(?:^id$|Id$|Ids$|_id$|_ids$)/.test(key);

function compactCritical(value: unknown, stringLimit: number, arrayLimit: number): unknown {
  if (typeof value === "string") {
    if (value.length <= stringLimit) return value;
    return `${value.slice(0, Math.max(0, stringLimit - 1))}…`;
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, arrayLimit).map((item) => compactCritical(item, stringLimit, arrayLimit));
    if (value.length > arrayLimit) {
      kept.push({ truncated: true, originalItemCount: value.length });
    }
    return kept;
  }
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>);
  const selected = entries.filter(([key]) => criticalKey(key));
  const source = selected.length > 0 ? selected : entries;
  const result: Record<string, unknown> = {};
  for (const [key, child] of source) {
    result[key] = compactCritical(child, stringLimit, arrayLimit);
  }
  return result;
}

function boundedRequiredField(value: unknown): unknown {
  if (jsonBytes(value) <= 4_096) return value;
  for (const [stringLimit, arrayLimit] of [[512, 8], [256, 4], [128, 2]] as const) {
    const compact = compactCritical(value, stringLimit, arrayLimit);
    if (jsonBytes(compact) <= 4_096) return compact;
  }
  const encoded = JSON.stringify(value);
  return {
    truncated: true,
    originalByteCount: Buffer.byteLength(encoded, "utf8"),
    preview: encoded.slice(0, 512),
  };
}

function requiredFieldFallback(actionResultId: string, full: unknown, withoutData: unknown): unknown {
  const root = withoutData && typeof withoutData === "object" && !Array.isArray(withoutData)
    ? withoutData as Record<string, unknown>
    : {};
  const receipt = root.receipt && typeof root.receipt === "object" && !Array.isArray(root.receipt)
    ? root.receipt as Record<string, unknown>
    : root;
  const fields = [
    "ok",
    "action",
    "status",
    "id",
    "ids",
    "changed",
    "changes",
    "warnings",
    "error",
    "recovery",
    "message",
    "code",
    "outcome",
    "data",
  ] as const;
  const required: Record<string, unknown> = {};
  for (const field of fields) {
    const source = Object.hasOwn(receipt, field) ? receipt : root;
    if (Object.hasOwn(source, field)) required[field] = boundedRequiredField(source[field]);
  }
  const dynamicIds = Object.fromEntries(
    Object.entries(receipt).filter(([key]) => /(?:^id$|Id$|Ids$|_id$|_ids$)/.test(key) && !fields.includes(key as typeof fields[number])),
  );
  if (Object.keys(dynamicIds).length > 0) required.identifiers = boundedRequiredField(dynamicIds);

  const summary = "receipt" in root
    ? { ...(root.kind !== undefined ? { kind: root.kind } : {}), receipt: required }
    : required;
  return {
    ...summary,
    actionResultId,
    originalByteCount: jsonBytes(full),
    truncated: true,
  };
}

/**
 * Build the one durable summary representation. Small results remain exact.
 * Oversized `data` is replaced by a pointer to the canonical row plus its
 * original byte count; a pathological result whose non-data metadata is itself
 * huge is deterministically compacted while retaining safety-relevant keys.
 */
export function buildActionResultSummary(actionResultId: string, result: unknown): unknown {
  const full = jsonClone(result);
  if (jsonBytes(full) <= ACTION_RESULT_SUMMARY_MAX_BYTES) return full;

  const withoutData = replaceData(full, actionResultId);
  if (jsonBytes(withoutData) <= ACTION_RESULT_SUMMARY_MAX_BYTES) return withoutData;

  for (const [stringLimit, arrayLimit] of [[4096, 64], [2048, 32], [1024, 16], [512, 8], [256, 4]] as const) {
    const compact = compactCritical(withoutData, stringLimit, arrayLimit);
    if (jsonBytes(compact) <= ACTION_RESULT_SUMMARY_MAX_BYTES) return compact;
  }

  return requiredFieldFallback(actionResultId, full, withoutData);
}

export function actionResultJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("action_result_not_json");
  JSON.parse(encoded);
  return encoded;
}
