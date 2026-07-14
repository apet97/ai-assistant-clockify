/**
 * Risky-update PREVIEW rendering: turn the typed patch the COMMIT will write
 * into legible `set <field> → <value>` lines so a model-garbled value is
 * catchable at preview time (the same philosophy as name→id resolution at
 * preview time). Patches never carry tokens by construction, so nothing
 * sensitive can surface here.
 */

/** Longest value rendered on a preview "set <field> → <value>" line. */
const MAX_PATCH_VALUE_LEN = 80;

/**
 * Render a single patch value for a risky-update PREVIEW card. Strings show
 * as-is (quoted so a trailing space / emptiness is visible); arrays/objects are
 * JSON; everything else stringifies. Long values are elided so the card stays
 * readable. Values come from the typed patch the COMMIT will write — never a
 * token (patches never carry secrets, by construction), so nothing sensitive
 * can surface here.
 */
function renderPatchValue(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = JSON.stringify(value);
  else if (value === null || value === undefined) text = String(value);
  else if (typeof value === "object") text = JSON.stringify(value);
  else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    text = String(value);
  } else if (typeof value === "symbol") {
    text = value.description ?? "Symbol";
  } else {
    text = "[function]";
  }
  return text.length > MAX_PATCH_VALUE_LEN ? `${text.slice(0, MAX_PATCH_VALUE_LEN - 1)}…` : text;
}

/**
 * Build the `expectedChanges` list for a risky UPDATE preview as
 * `set <field> → <value>` — the value the commit will actually write, not just
 * the field name. A model-garbled value (wrong currency, mangled note) is then
 * catchable at preview time, the same philosophy as name→id resolution at
 * preview time. Values are clamped/stringified by {@link renderPatchValue};
 * patches never carry tokens, so nothing sensitive can leak.
 */
export function describePatch(patch: Record<string, unknown>): string[] {
  return Object.entries(patch).map(([field, value]) => `set ${field} → ${renderPatchValue(value)}`);
}
