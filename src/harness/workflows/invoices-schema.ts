import type { ActionContext } from "../action.js";

/**
 * Invoice item-type discovery (extracted from `invoices.ts`). Invoice item types are
 * workspace-CONFIGURED NAMES (live-verified via the REST API: `itemType` must match a
 * configured name — not an enum or id — and the names vary per workspace; "NEW DEFAULT"
 * only happens to be one workspace's default). Clockify exposes NO endpoint to list or
 * create them, but every line item stores its `itemType` name, so we DISCOVER the valid
 * names from the workspace's existing invoices (bounded scan) rather than blindly sending
 * a guess. Returns the distinct configured names (empty on a workspace that has never had
 * an invoice line item).
 *
 * `invoices` lets a caller that JUST fetched the invoice list (e.g. `resolveInvoiceRef`)
 * share it, so an item-add preview issues exactly one `listInvoices`. Only the ≤12
 * most-recent invoices are scanned, and their detail GETs run with bounded concurrency
 * (each is a real `GET /invoices/{id}`) so the discovery scan overlaps instead of
 * awaiting one at a time.
 */
const MAX_INVOICES_SCANNED_FOR_TYPES = 12;
const ITEM_TYPE_SCAN_CONCURRENCY = 4;

export async function discoverItemTypes(
  ctx: ActionContext,
  invoices?: ReadonlyArray<{ id: string }>,
): Promise<string[]> {
  const all = invoices ?? (await ctx.clockify.listInvoices());
  const scanned = all.slice(0, MAX_INVOICES_SCANNED_FOR_TYPES);
  const names = new Set<string>();
  // Bounded-concurrency scan: chunk the ≤12 detail GETs so up to
  // ITEM_TYPE_SCAN_CONCURRENCY are in flight at once (kind to the add-on rate
  // limit) instead of one strictly-sequential await per invoice.
  for (let i = 0; i < scanned.length; i += ITEM_TYPE_SCAN_CONCURRENCY) {
    const chunk = scanned.slice(i, i + ITEM_TYPE_SCAN_CONCURRENCY);
    const itemLists = await Promise.all(chunk.map((inv) => ctx.clockify.listInvoiceItems(inv.id)));
    for (const items of itemLists) for (const it of items) if (it.itemType) names.add(it.itemType);
  }
  return [...names];
}

export type ItemTypeResolution =
  | { ok: true; itemType: string }
  | { ok: false; options: string[] };

/**
 * Resolve a requested (or omitted) item type against the workspace's discovered types: a
 * case-insensitive match yields the canonical name; an unknown request when types DO exist
 * asks the admin to choose (never a raw 404); an omitted type defaults to the first
 * configured one. When NOTHING is discoverable (a fresh workspace), fall back to the
 * requested value or "NEW DEFAULT" and let the commit-time warning surface the constraint.
 */
export function resolveItemType(discovered: string[], requested?: string): ItemTypeResolution {
  if (discovered.length === 0) return { ok: true, itemType: requested ?? "NEW DEFAULT" };
  if (!requested) return { ok: true, itemType: discovered[0] };
  const match = discovered.find((d) => d.toLowerCase() === requested.toLowerCase());
  return match ? { ok: true, itemType: match } : { ok: false, options: discovered };
}

export function itemTypeClarify(options: string[]): { clarify: string; options: { id: string; label: string }[] } {
  return {
    clarify: `This workspace's invoice item types are: ${options.join(", ")}. Which should I use? (I can't create a new type via the API — add a line item once in the Clockify invoice editor and it auto-creates a type I can then reuse.)`,
    options: options.map((t) => ({ id: t, label: t })),
  };
}

/**
 * Map a pair of "is this tax rate set?" booleans to Clockify's item-based tax
 * apply flag. When the invoice carries a rate, its line items default to taxed
 * (Clockify's TAX/TAX2 columns are checked by default); no rate ⇒ no flag. The
 * one place this mapping lives so create-with-items and items_add can't drift —
 * an explicit per-item `applyTaxes` still wins at the call site.
 */
export function taxApplyFlag(
  hasTax1: boolean,
  hasTax2: boolean,
): "TAX1TAX2" | "TAX2" | "TAX1" | undefined {
  return hasTax1 && hasTax2 ? "TAX1TAX2" : hasTax2 ? "TAX2" : hasTax1 ? "TAX1" : undefined;
}
