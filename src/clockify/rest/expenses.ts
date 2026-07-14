import type { RestCore } from "./core.js";
import { toClockifyDate } from "./wire-dates.js";
import { fromMinor } from "../../harness/money.js";
import type { EntitySummary } from "../types.js";
import type {
  ExpensePort,
  ExpenseSummary,
  ExpenseCategorySummary,
  CreateExpenseInput,
  UpdateExpenseInput,
  PreparedExpenseUpdateInput,
} from "../ports/expenses.js";
import { AmbiguousWriteOutcome } from "../write-outcome.js";

// Expenses are MAJOR units on the wire (unlike invoices, which are minor). The
// action layer stores canonical MINOR units in the payload, so the REST module
// renders them back through `fromMinor` (÷100, 2 fixed decimals) here.

/** Coerce a number or numeric string to a number (Clockify mixes both). */
function numFrom(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

/**
 * Reconstruct the per-unit MAJOR amount the create/update form expects from an
 * existing expense read. The GET returns `total` (MINOR units) and `quantity`
 * (there is no `amount` field), so per-unit major = total / quantity / 100. The
 * form's `amount` is per-unit and Clockify recomputes total = amount × quantity,
 * so {@link updateExpense} re-sends `quantity` alongside this to keep the total.
 */
function existingAmount(existing: Record<string, unknown>): string | undefined {
  const total = numFrom(existing.total);
  if (total === undefined) return undefined;
  const qty = numFrom(existing.quantity) || 1;
  return fromMinor(total / qty);
}

function mapExpense(raw: Record<string, unknown>): ExpenseSummary {
  const name = (raw.notes as string | undefined) ?? (raw.id as string);
  const out: ExpenseSummary = { id: raw.id as string, name };
  if (raw.userId !== undefined) out.userId = raw.userId as string;
  if (raw.notes !== undefined) out.notes = raw.notes as string;
  if (raw.date !== undefined) out.date = raw.date as string;
  if (raw.categoryId !== undefined) out.categoryId = raw.categoryId as string;
  if (raw.categoryName !== undefined) out.categoryName = raw.categoryName as string;
  if (typeof raw.billable === "boolean") out.billable = raw.billable;
  if (raw.projectId !== undefined) out.projectId = raw.projectId as string;
  if (raw.taskId !== undefined) out.taskId = raw.taskId as string;
  if (typeof raw.total === "number") out.total = raw.total; // MINOR units
  if (typeof raw.quantity === "number") out.quantity = raw.quantity;
  return out;
}

/** Category row fields read by {@link mapCategory}. */
type CategoryRow = {
  id?: string;
  name?: string;
  archived?: boolean;
};

function mapCategory(raw: Record<string, unknown>): ExpenseCategorySummary {
  const out: ExpenseCategorySummary = { id: raw.id as string, name: raw.name as string };
  if (typeof raw.archived === "boolean") out.archived = raw.archived;
  return out;
}

/**
 * Typed expense REST module (goclmcp §2.7). Reads are immediate; the risky
 * methods run only from a handler's `commit`. Shapes pinned by the live probe +
 * unit tests: list is DOUBLE-nested (`{expenses:{expenses:[…],count}}`);
 * create/update are `multipart/form-data` (built via the shared FormData path on
 * `core.call`); the wire amount is MAJOR units; update GET-then-merges and sends
 * `changeFields` tokens plus a required `userId`.
 */
export function makeExpenseRest(core: RestCore, workspaceId: string): ExpensePort {
  const ws = `/workspaces/${workspaceId}`;

  const createExpenseAtomic = async (input: CreateExpenseInput): Promise<EntitySummary> => {
    const fields: Record<string, string> = {
      userId: input.userId,
      amount: fromMinor(input.amountMinor),
      date: toClockifyDate(input.date),
      categoryId: input.categoryId,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.billable !== undefined ? { billable: String(input.billable) } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    };
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    const created = (await core.mutate("api", "POST", `${ws}/expenses`, form)) as { id?: unknown; notes?: string } | null;
    if (typeof created?.id !== "string" || created.id.length === 0) {
      throw new AmbiguousWriteOutcome("POST", `${ws}/expenses`, "Clockify returned a successful expense response without a usable id.");
    }
    return { id: created.id, name: created.notes ?? input.notes ?? created.id };
  };

  const prepareExpenseUpdate = async (id: string, input: UpdateExpenseInput): Promise<PreparedExpenseUpdateInput> => {
    const existing = ((await core.call("api", "GET", `${ws}/expenses/${id}`)) ?? {}) as Record<string, unknown>;
    return {
      changeFields: [...input.changeFields],
      ...(((existing.userId as string | undefined) ?? input.userId) ? { userId: (existing.userId as string | undefined) ?? input.userId } : {}),
      ...((input.amountMinor !== undefined ? fromMinor(input.amountMinor) : existingAmount(existing)) !== undefined
        ? { amount: input.amountMinor !== undefined ? fromMinor(input.amountMinor) : existingAmount(existing) } : {}),
      ...(numFrom(existing.quantity) !== undefined ? { quantity: numFrom(existing.quantity) } : {}),
      ...((input.date !== undefined ? toClockifyDate(input.date) : existing.date as string | undefined) ? { date: input.date !== undefined ? toClockifyDate(input.date) : existing.date as string } : {}),
      ...((input.categoryId ?? existing.categoryId as string | undefined) ? { categoryId: input.categoryId ?? existing.categoryId as string } : {}),
      ...((input.notes !== undefined ? input.notes : existing.notes as string | undefined) !== undefined ? { notes: input.notes !== undefined ? input.notes : existing.notes as string } : {}),
      ...((input.billable !== undefined ? input.billable : existing.billable as boolean | undefined) !== undefined ? { billable: input.billable !== undefined ? input.billable : existing.billable as boolean } : {}),
      ...((input.projectId ?? existing.projectId as string | undefined) ? { projectId: input.projectId ?? existing.projectId as string } : {}),
      ...((input.taskId ?? existing.taskId as string | undefined) ? { taskId: input.taskId ?? existing.taskId as string } : {}),
    };
  };

  const updateExpenseAtomic = async (id: string, input: PreparedExpenseUpdateInput): Promise<EntitySummary> => {
    const form = new FormData();
    for (const token of input.changeFields) form.append("changeFields", token);
    for (const key of ["userId", "amount", "quantity", "date", "categoryId", "notes", "billable", "projectId", "taskId"] as const) {
      const value = input[key];
      if (value !== undefined) form.append(key, String(value));
    }
    const updated = (await core.mutate("api", "PUT", `${ws}/expenses/${id}`, form)) as { id?: string; notes?: string };
    return { id: updated?.id ?? id, name: updated?.notes ?? input.notes ?? id };
  };

  const deleteExpenseAtomic = async (id: string): Promise<void> => { await core.mutate("api", "DELETE", `${ws}/expenses/${id}`); };
  const createCategoryAtomic = async ({ name }: { name: string }): Promise<EntitySummary> => {
    const c = (await core.mutate("api", "POST", `${ws}/expenses/categories`, { name })) as { id?: unknown; name?: string } | null;
    if (typeof c?.id !== "string" || c.id.length === 0) {
      throw new AmbiguousWriteOutcome("POST", `${ws}/expenses/categories`, "Clockify returned a successful expense-category response without a usable id.");
    }
    return { id: c.id, name: c.name ?? name };
  };
  const updateCategoryAtomic = async (id: string, patch: { name?: string }): Promise<EntitySummary> => {
    const c = (await core.mutate("api", "PUT", `${ws}/expenses/categories/${id}`, patch)) as { id?: string; name?: string };
    return { id: c?.id ?? id, name: c?.name ?? patch.name ?? id };
  };
  const setCategoryArchivedAtomic = async (id: string, archived: boolean): Promise<void> => { await core.mutate("api", "PATCH", `${ws}/expenses/categories/${id}/status`, { archived }); };
  const deleteCategoryAtomic = async (id: string): Promise<void> => { await core.mutate("api", "DELETE", `${ws}/expenses/categories/${id}`); };

  return {
    async listExpenses(filter) {
      // The list is DOUBLE-nested (`{expenses:{expenses:[…],count}}`); paginate
      // via the dotted envelope key so >50 expenses don't truncate and the
      // MAX_PAGES backstop warning fires when a list is capped. A bare array is
      // tolerated by the unwrap.
      const params: Record<string, string> = {};
      if (filter?.start) params.start = filter.start;
      if (filter?.end) params.end = filter.end;
      const result = await core.paginateEnvelope("api", `${ws}/expenses`, "expenses.expenses", params);
      return { ...result, rows: (result.rows as Record<string, unknown>[]).map(mapExpense) };
    },
    async getExpense(id) {
      const raw = await core.call("api", "GET", `${ws}/expenses/${id}`, undefined, true);
      return raw ? mapExpense(raw as Record<string, unknown>) : null;
    },
    async createExpense(input): Promise<EntitySummary> {
      return createExpenseAtomic(input);
    },
    createExpenseAtomic,
    async updateExpense(id, input): Promise<EntitySummary> {
      return updateExpenseAtomic(id, await prepareExpenseUpdate(id, input));
    },
    prepareExpenseUpdate,
    updateExpenseAtomic,
    async deleteExpense(id) {
      await deleteExpenseAtomic(id);
    },
    deleteExpenseAtomic,
    async listExpenseCategories(filter) {
      // The spec's archived param DEFAULTS to false (active-only) — name
      // resolution for deletes must be able to ask for the archived set.
      // Paginate (envelope: `{categories:[…]}`) so >50 categories don't truncate.
      const params: Record<string, string> = filter?.archived === undefined ? {} : { archived: String(filter.archived) };
      const result = await core.paginateEnvelope("api", `${ws}/expenses/categories`, "categories", params);
      return { ...result, rows: (result.rows as CategoryRow[]).map(mapCategory) };
    },
    async createExpenseCategory({ name }): Promise<EntitySummary> {
      return createCategoryAtomic({ name });
    },
    createExpenseCategoryAtomic: createCategoryAtomic,
    async updateExpenseCategory(id, patch): Promise<EntitySummary> {
      return updateCategoryAtomic(id, patch);
    },
    updateExpenseCategoryAtomic: updateCategoryAtomic,
    async setExpenseCategoryArchived(id, archived) {
      await setCategoryArchivedAtomic(id, archived);
    },
    setExpenseCategoryArchivedAtomic: setCategoryArchivedAtomic,
    async deleteExpenseCategory(id) {
      // Clockify rejects deleting an active category ("Category must be archived to
      // be deleted"); archive via PATCH /status, then delete.
      await setCategoryArchivedAtomic(id, true);
      await deleteCategoryAtomic(id);
    },
    deleteExpenseCategoryAtomic: deleteCategoryAtomic,
  };
}
