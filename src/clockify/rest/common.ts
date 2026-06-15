import type { EntitySummary } from "../types.js";

/**
 * Canonical row → EntitySummary mapper for the `{ id, name, archived }` shape
 * shared by clients, tags, and other simple workspace entities. Centralises the
 * one untyped boundary cast (rows arrive from `core.call`/`core.paginate` as
 * `unknown`) so a new EntitySummary field is carried — and narrowed — in one place.
 *
 * New simple workspace entities (id/name/archived) should route through this
 * helper rather than re-deriving a fresh inline mapper. The divergent
 * ProjectSummary/TaskSummary mappers (richer shapes) are intentionally separate.
 */
export function mapEntitySummary(row: unknown): EntitySummary {
  const r = row as { id: string; name: string; archived?: boolean };
  return { id: r.id, name: r.name, archived: r.archived };
}
