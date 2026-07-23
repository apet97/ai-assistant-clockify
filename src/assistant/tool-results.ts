import type { SuccessReceipt, ErrorReceipt } from "../harness/receipts.js";

/**
 * Byte budget for ONE tool result fed back to the model. Receipts are unbounded
 * in canonical storage; only the model-visible copy is pruned.
 */
export const TOOL_RESULT_MAX_BYTES = 24_000;

/** Longest string leaf kept verbatim when a receipt must be pruned. */
const PRUNED_STRING_CHARS = 2_000;
/** Longest array kept when a receipt must be pruned (head sample — ids survive). */
const PRUNED_ARRAY_ITEMS = 25;

function pruneValue(value: unknown): unknown {
  if (typeof value === "string" && value.length > PRUNED_STRING_CHARS) {
    return `${value.slice(0, PRUNED_STRING_CHARS)}…[truncated ${value.length - PRUNED_STRING_CHARS} chars]`;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, PRUNED_ARRAY_ITEMS).map(pruneValue);
    if (value.length > PRUNED_ARRAY_ITEMS) {
      head.push(`…truncated: ${value.length - PRUNED_ARRAY_ITEMS} more item(s) omitted for the model; ask a narrower query for the rest`);
    }
    return head;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, pruneValue(v)]));
  }
  return value;
}

/**
 * Serialize a receipt for the model, byte-capped. A small receipt passes through
 * byte-identical; an oversized one is pruned and, if still over the budget,
 * its `data` is replaced wholesale with an honest note.
 */
export function capToolResultForModel(receipt: SuccessReceipt | ErrorReceipt): string {
  const full = JSON.stringify(receipt);
  if (Buffer.byteLength(full, "utf8") <= TOOL_RESULT_MAX_BYTES) return full;

  const pruned = JSON.stringify({ ...(pruneValue(receipt) as object), truncatedForModel: true });
  if (Buffer.byteLength(pruned, "utf8") <= TOOL_RESULT_MAX_BYTES) return pruned;

  const { data: _data, ...rest } = receipt as unknown as { data?: unknown } & Record<string, unknown>;
  return JSON.stringify({
    ...rest,
    truncatedForModel: true,
    data: {
      note: `result too large to show the model (${Buffer.byteLength(full, "utf8")} bytes); the admin saw the full result — ask a narrower query if you need the details`,
    },
  });
}
