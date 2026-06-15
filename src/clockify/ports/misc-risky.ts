import type { EntitySummary } from "../types.js";

/**
 * Transitional slice holding the current GENERIC risky-write methods (delete /
 * webhook / entity-update / expense / time-off / schedule). Each is optional
 * (`?`) — they execute only at confirm time, after a button confirmation. As
 * each feature-area phase lands, its typed methods supersede the matching
 * generic method here, and the generic one is removed. (Invoices were superseded
 * by the typed `InvoicePort` in Phase 6.)
 */
export interface MiscRiskyPort {
  /**
   * Risky-write methods (used only at confirm time, after button confirmation).
   * `projectId` is REQUIRED for a `task` delete (Clockify scopes tasks under a
   * project); it is ignored for every other type.
   */
  deleteEntity?(input: { entityType: string; id: string; projectId?: string }): Promise<void>;
  /** Generic entity update (risky — committed only after button confirmation). */
  updateEntity?(input: {
    entityType: string;
    id: string;
    fields?: Record<string, unknown>;
  }): Promise<EntitySummary>;
}
