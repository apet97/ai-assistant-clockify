import type { EntitySummary } from "../client.js";

/** List filter for expenses (date range, full ISO or YYYY-MM-DD). */
export interface ExpenseFilter {
  start?: string;
  end?: string;
}

/**
 * Compact expense view. `name` is the expense `notes` (expenses have no name),
 * falling back to the id. `amount` is passed through as Clockify returns it
 * (major currency units on this surface) — informational only.
 */
export interface ExpenseSummary extends EntitySummary {
  notes?: string;
  date?: string;
  categoryId?: string;
  categoryName?: string;
  billable?: boolean;
  projectId?: string;
  taskId?: string;
  amount?: number;
}

export interface ExpenseCategorySummary extends EntitySummary {
  archived?: boolean;
}

export interface CreateExpenseInput {
  /** Expense owner; Clockify rejects a create without it. Injected from the admin. */
  userId: string;
  /** Already converted to minor units (cents); the REST module sends major on the wire. */
  amountMinor: number;
  date: string; // full ISO or YYYY-MM-DD
  categoryId: string;
  notes?: string;
  billable?: boolean;
  projectId?: string;
  taskId?: string;
}

export interface UpdateExpenseInput {
  /** Tokens enumerating which fields to apply: AMOUNT, DATE, CATEGORY, NOTES, BILLABLE, PROJECT, TASK. */
  changeFields: string[];
  /** Fallback owner if the existing expense lacks one (Clockify requires userId on the form). */
  userId?: string;
  amountMinor?: number;
  date?: string;
  categoryId?: string;
  notes?: string;
  billable?: boolean;
  projectId?: string;
  taskId?: string;
}

/**
 * Expense slice of the {@link WorkspaceClient} port (goclmcp §2.7). Reads are
 * immediate; create/update/delete + category writes are risky (commit-only).
 * Gotchas pinned by the live probe + unit tests: list is a DOUBLE-nested
 * envelope (`{expenses:{expenses:[…],count}}`); create/update are
 * `multipart/form-data`; the wire amount is MAJOR units (the action stores minor
 * and the REST module divides by 100); update uses `changeFields` tokens and a
 * required `userId`.
 */
export interface ExpensePort {
  listExpenses(filter?: ExpenseFilter): Promise<ExpenseSummary[]>;
  getExpense(id: string): Promise<ExpenseSummary | null>;
  createExpense(input: CreateExpenseInput): Promise<EntitySummary>;
  updateExpense(id: string, input: UpdateExpenseInput): Promise<EntitySummary>;
  deleteExpense(id: string): Promise<void>;
  listExpenseCategories(): Promise<ExpenseCategorySummary[]>;
  createExpenseCategory(input: { name: string }): Promise<EntitySummary>;
  updateExpenseCategory(id: string, patch: { name?: string }): Promise<EntitySummary>;
  deleteExpenseCategory(id: string): Promise<void>;
}
