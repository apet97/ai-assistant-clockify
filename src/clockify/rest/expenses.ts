import type { RestCore } from "./core.js";
import { toClockifyDate } from "./wire-dates.js";
import { fromMinor } from "../../harness/money.js";
import type { EntitySummary } from "../types.js";
import type {
  ExpensePort,
  ExpenseSummary,
  ExpenseCategorySummary,
} from "../ports/expenses.js";

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

  return {
    async listExpenses(filter) {
      // The list is DOUBLE-nested (`{expenses:{expenses:[…],count}}`); paginate
      // via the dotted envelope key so >50 expenses don't truncate and the
      // MAX_PAGES backstop warning fires when a list is capped. A bare array is
      // tolerated by the unwrap.
      const params: Record<string, string> = {};
      if (filter?.start) params.start = filter.start;
      if (filter?.end) params.end = filter.end;
      const rows = (await core.paginateEnvelope("api", `${ws}/expenses`, "expenses.expenses", params)) as Record<string, unknown>[];
      return rows.map(mapExpense);
    },
    async getExpense(id) {
      const raw = await core.call("api", "GET", `${ws}/expenses/${id}`, undefined, true);
      return raw ? mapExpense(raw as Record<string, unknown>) : null;
    },
    async createExpense(input): Promise<EntitySummary> {
      // multipart/form-data — Clockify requires userId; amount is MAJOR on the wire.
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
      const created = (await core.postForm("api", `${ws}/expenses`, fields)) as {
        id: string;
        notes?: string;
      };
      return { id: created.id, name: created.notes ?? input.notes ?? created.id };
    },
    async updateExpense(id, input): Promise<EntitySummary> {
      // The multipart PUT REPLACES the expense, so the base fields (userId, date,
      // categoryId, amount) must always be present — even when only notes change.
      // Source each from the caller's value when provided, else from the existing
      // expense. An UNCHANGED amount is echoed back exactly as Clockify returned
      // it (no unit conversion → no 100x risk); a changed amount goes minor→major.
      const existing = ((await core.call("api", "GET", `${ws}/expenses/${id}`)) ?? {}) as Record<string, unknown>;
      const form = new FormData();
      for (const token of input.changeFields) form.append("changeFields", token);

      const userId = (existing.userId as string | undefined) ?? input.userId;
      if (userId) form.append("userId", userId);

      const amount =
        input.amountMinor !== undefined ? fromMinor(input.amountMinor) : existingAmount(existing);
      if (amount !== undefined) form.append("amount", amount);

      // Re-send quantity so a per-unit amount keeps the same total on the replace.
      const quantity = numFrom(existing.quantity);
      if (quantity !== undefined) form.append("quantity", String(quantity));

      const date = input.date !== undefined ? toClockifyDate(input.date) : (existing.date as string | undefined);
      if (date) form.append("date", date);

      const categoryId = input.categoryId ?? (existing.categoryId as string | undefined);
      if (categoryId) form.append("categoryId", categoryId);

      const notes = input.notes !== undefined ? input.notes : (existing.notes as string | undefined);
      if (notes !== undefined) form.append("notes", notes);

      const billable = input.billable !== undefined ? input.billable : (existing.billable as boolean | undefined);
      if (typeof billable === "boolean") form.append("billable", String(billable));

      const projectId = input.projectId ?? (existing.projectId as string | undefined);
      if (projectId) form.append("projectId", projectId);

      const taskId = input.taskId ?? (existing.taskId as string | undefined);
      if (taskId) form.append("taskId", taskId);

      const updated = (await core.call("api", "PUT", `${ws}/expenses/${id}`, form)) as {
        id?: string;
        notes?: string;
      };
      return { id: updated?.id ?? id, name: updated?.notes ?? input.notes ?? id };
    },
    async deleteExpense(id) {
      await core.call("api", "DELETE", `${ws}/expenses/${id}`);
    },
    async listExpenseCategories(filter) {
      // The spec's archived param DEFAULTS to false (active-only) — name
      // resolution for deletes must be able to ask for the archived set.
      // Paginate (envelope: `{categories:[…]}`) so >50 categories don't truncate.
      const params: Record<string, string> = filter?.archived === undefined ? {} : { archived: String(filter.archived) };
      const rows = (await core.paginateEnvelope("api", `${ws}/expenses/categories`, "categories", params)) as any[];
      return rows.map(mapCategory);
    },
    async createExpenseCategory({ name }): Promise<EntitySummary> {
      const c = (await core.call("api", "POST", `${ws}/expenses/categories`, { name })) as {
        id: string;
        name?: string;
      };
      return { id: c.id, name: c.name ?? name };
    },
    async updateExpenseCategory(id, patch): Promise<EntitySummary> {
      const body: Record<string, unknown> = {};
      if (patch.name !== undefined) body.name = patch.name;
      const c = (await core.call("api", "PUT", `${ws}/expenses/categories/${id}`, body)) as {
        id?: string;
        name?: string;
      };
      return { id: c?.id ?? id, name: c?.name ?? patch.name ?? id };
    },
    async setExpenseCategoryArchived(id, archived) {
      await core.call("api", "PATCH", `${ws}/expenses/categories/${id}/status`, { archived });
    },
    async deleteExpenseCategory(id) {
      // Clockify rejects deleting an active category ("Category must be archived to
      // be deleted"); archive via PATCH /status, then delete.
      await core.call("api", "PATCH", `${ws}/expenses/categories/${id}/status`, { archived: true });
      await core.call("api", "DELETE", `${ws}/expenses/categories/${id}`);
    },
  };
}
