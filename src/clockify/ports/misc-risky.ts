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
  manageWebhook?(input: {
    operation: "create" | "update" | "delete";
    id?: string;
    name?: string;
    url?: string;
    /** Clockify requires webhookEvent + trigger source on create. */
    webhookEvent?: string;
    triggerSource?: string[];
    triggerSourceType?: string;
    authToken?: string;
  }): Promise<EntitySummary | null>;
  /** Generic entity update (risky — committed only after button confirmation). */
  updateEntity?(input: {
    entityType: string;
    id: string;
    fields?: Record<string, unknown>;
  }): Promise<EntitySummary>;
  /** Expense create/update/delete (risky — confirm-gated). Create is multipart. */
  manageExpense?(input: {
    operation: "create" | "update" | "delete";
    id?: string;
    name?: string;
    amount?: number;
    date?: string; // YYYY-MM-DD; required by Clockify on create
    categoryId?: string; // required by Clockify on create
    userId?: string; // required by Clockify on create (the expense's owner)
  }): Promise<EntitySummary | null>;
  /** Approve/deny a time-off request (risky external side effect — confirm-gated). */
  manageTimeOff?(input: {
    policyId: string; // Clockify approves/denies under a specific policy
    requestId: string;
    decision: "approve" | "deny";
  }): Promise<EntitySummary | null>;
  /** Publish a schedule for a date range (risky external side effect — confirm-gated). */
  manageSchedule?(input: {
    operation: "publish";
    start?: string;
    end?: string;
  }): Promise<EntitySummary | null>;
}
