import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type {
  ExpenseSummary,
  ExpenseCategorySummary,
} from "../../../src/clockify/ports/expenses.js";
import { fakeListResult, type FakeContext } from "./state.js";

export function makeFakeExpenses({ state, seed, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "listExpenses"
  | "getExpense"
  | "createExpense"
  | "updateExpense"
  | "deleteExpense"
  | "listExpenseCategories"
  | "createExpenseCategory"
  | "updateExpenseCategory"
  | "setExpenseCategoryArchived"
  | "deleteExpenseCategory"
> {
  return {
    async listExpenses() {
      bump("listExpenses");
      return fakeListResult(seed, "listExpenses", state.expenses);
    },
    async getExpense(id) {
      bump("getExpense");
      return state.expenses.find((e) => e.id === id) ?? null;
    },
    async createExpense(input) {
      bump("createExpense");
      const expense: ExpenseSummary = {
        id: nextId("expense"),
        name: input.notes ?? "expense",
        notes: input.notes,
        date: input.date,
        categoryId: input.categoryId,
        billable: input.billable,
        // The create amount is per-unit; the fake uses quantity 1, so total = amountMinor.
        total: input.amountMinor,
        quantity: 1,
      };
      state.expenses.push(expense);
      return { id: expense.id, name: expense.name };
    },
    async updateExpense(id, input) {
      bump("updateExpense");
      const index = state.expenses.findIndex((e) => e.id === id);
      if (index >= 0) {
        const base = state.expenses[index];
        const updated: ExpenseSummary = {
          ...base,
          ...(input.notes !== undefined ? { notes: input.notes, name: input.notes } : {}),
          ...(input.date !== undefined ? { date: input.date } : {}),
          ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          ...(input.billable !== undefined ? { billable: input.billable } : {}),
          ...(input.amountMinor !== undefined ? { total: input.amountMinor } : {}),
        };
        state.expenses[index] = updated;
        return { id, name: updated.name };
      }
      return { id, name: input.notes ?? id };
    },
    async deleteExpense(id) {
      bump("deleteExpense");
      state.expenses = state.expenses.filter((e) => e.id !== id);
      state.deleted.push({ entityType: "expense", id });
    },
    async listExpenseCategories(filter) {
      bump("listExpenseCategories");
      const rows = filter?.archived === undefined
        ? state.expenseCategories
        : state.expenseCategories.filter((c) => Boolean(c.archived) === filter.archived);
      return fakeListResult(seed, "listExpenseCategories", rows);
    },
    async createExpenseCategory({ name }) {
      bump("createExpenseCategory");
      const c: ExpenseCategorySummary = { id: nextId("cat"), name };
      state.expenseCategories.push(c);
      return { id: c.id, name: c.name };
    },
    async updateExpenseCategory(id, patch) {
      bump("updateExpenseCategory");
      const index = state.expenseCategories.findIndex((c) => c.id === id);
      const base: ExpenseCategorySummary = index >= 0 ? state.expenseCategories[index] : { id, name: id };
      const updated: ExpenseCategorySummary = {
        ...base,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
      };
      if (index >= 0) state.expenseCategories[index] = updated;
      else state.expenseCategories.push(updated);
      return { id, name: updated.name };
    },
    async setExpenseCategoryArchived(id, archived) {
      bump("setExpenseCategoryArchived");
      const cat = state.expenseCategories.find((c) => c.id === id);
      if (cat) cat.archived = archived;
    },
    async deleteExpenseCategory(id) {
      bump("deleteExpenseCategory");
      state.expenseCategories = state.expenseCategories.filter((c) => c.id !== id);
      state.deleted.push({ entityType: "expense_category", id });
    },
  };
}
