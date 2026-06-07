import type { EntitySummary } from "../client.js";

/**
 * Expense slice of the {@link WorkspaceClient} port (goclmcp §2.7). Phase 7
 * extends this with typed get/create/update/delete and category methods.
 */
export interface ExpensePort {
  listExpenses(): Promise<EntitySummary[]>;
}
