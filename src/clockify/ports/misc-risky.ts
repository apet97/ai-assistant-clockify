import type { EntitySummary } from "../client.js";

/**
 * Transitional slice holding the current GENERIC risky-write methods (delete /
 * webhook / entity-update / expense / time-off / schedule). Each is optional
 * (`?`) — they execute only at confirm time, after a button confirmation. As
 * each feature-area phase lands, its typed methods supersede the matching
 * generic method here, and the generic one is removed. (Invoices were superseded
 * by the typed `InvoicePort` in Phase 6.)
 */
export interface MiscRiskyPort {
  /** Risky-write methods (used only at confirm time, after button confirmation). */
  deleteEntity?(input: { entityType: string; id: string }): Promise<void>;
  /** Generic entity update (risky — committed only after button confirmation). */
  updateEntity?(input: {
    entityType: string;
    id: string;
    fields?: Record<string, unknown>;
  }): Promise<EntitySummary>;
}
