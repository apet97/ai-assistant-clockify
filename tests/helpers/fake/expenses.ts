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
  | "createExpenseAtomic"
  | "updateExpense"
  | "prepareExpenseUpdate"
  | "updateExpenseAtomic"
  | "deleteExpense"
  | "deleteExpenseAtomic"
  | "listExpenseCategories"
  | "createExpenseCategory"
  | "createExpenseCategoryAtomic"
  | "updateExpenseCategory"
  | "updateExpenseCategoryAtomic"
  | "setExpenseCategoryArchived"
  | "setExpenseCategoryArchivedAtomic"
  | "deleteExpenseCategory"
  | "deleteExpenseCategoryAtomic"
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
    async createExpenseAtomic(input) {
      bump("createExpenseAtomic");
      const expense: ExpenseSummary = { id: nextId("expense"), name: input.notes ?? "expense", notes: input.notes, date: input.date, categoryId: input.categoryId, billable: input.billable, total: input.amountMinor, quantity: 1, userId: input.userId };
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
    async prepareExpenseUpdate(id, input) {
      bump("prepareExpenseUpdate");
      const current = state.expenses.find((expense) => expense.id === id);
      if (!current) throw new Error("expense_not_found");
      return JSON.parse(JSON.stringify({
        changeFields: [...input.changeFields],
        userId: current.userId ?? input.userId,
        amount: String((input.amountMinor ?? current.total ?? 0) / 100),
        quantity: current.quantity ?? 1,
        date: input.date ?? current.date,
        categoryId: input.categoryId ?? current.categoryId,
        notes: input.notes ?? current.notes,
        billable: input.billable ?? current.billable,
        projectId: input.projectId ?? current.projectId,
        taskId: input.taskId ?? current.taskId,
      })) as Awaited<ReturnType<WorkspaceClient["prepareExpenseUpdate"]>>;
    },
    async updateExpenseAtomic(id, input) {
      bump("updateExpenseAtomic");
      const index = state.expenses.findIndex((expense) => expense.id === id);
      const base = state.expenses[index];
      if (!base) throw new Error("expense_not_found");
      const quantity = input.quantity ?? base.quantity ?? 1;
      const updated: ExpenseSummary = { ...base, ...(input.userId ? { userId: input.userId } : {}), ...(input.notes !== undefined ? { notes: input.notes, name: input.notes } : {}), ...(input.date ? { date: input.date } : {}), ...(input.categoryId ? { categoryId: input.categoryId } : {}), ...(input.billable !== undefined ? { billable: input.billable } : {}), ...(input.amount !== undefined ? { total: Number(input.amount) * 100 * quantity } : {}), quantity, ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.taskId ? { taskId: input.taskId } : {}) };
      state.expenses[index] = updated;
      return { id, name: updated.name };
    },
    async deleteExpense(id) {
      bump("deleteExpense");
      state.expenses = state.expenses.filter((e) => e.id !== id);
      state.deleted.push({ entityType: "expense", id });
    },
    async deleteExpenseAtomic(id) {
      bump("deleteExpenseAtomic");
      state.expenses = state.expenses.filter((expense) => expense.id !== id);
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
    async createExpenseCategoryAtomic({ name }) {
      bump("createExpenseCategoryAtomic");
      const category: ExpenseCategorySummary = { id: nextId("cat"), name };
      state.expenseCategories.push(category);
      return category;
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
    async updateExpenseCategoryAtomic(id, patch) {
      bump("updateExpenseCategoryAtomic");
      const category = state.expenseCategories.find((row) => row.id === id);
      if (!category) throw new Error("expense_category_not_found");
      if (patch.name !== undefined) category.name = patch.name;
      return { id, name: category.name };
    },
    async setExpenseCategoryArchived(id, archived) {
      bump("setExpenseCategoryArchived");
      const cat = state.expenseCategories.find((c) => c.id === id);
      if (cat) cat.archived = archived;
    },
    async setExpenseCategoryArchivedAtomic(id, archived) {
      bump("setExpenseCategoryArchivedAtomic");
      const category = state.expenseCategories.find((row) => row.id === id);
      if (!category) throw new Error("expense_category_not_found");
      category.archived = archived;
    },
    async deleteExpenseCategory(id) {
      bump("deleteExpenseCategory");
      state.expenseCategories = state.expenseCategories.filter((c) => c.id !== id);
      state.deleted.push({ entityType: "expense_category", id });
    },
    async deleteExpenseCategoryAtomic(id) {
      bump("deleteExpenseCategoryAtomic");
      state.expenseCategories = state.expenseCategories.filter((category) => category.id !== id);
      state.deleted.push({ entityType: "expense_category", id });
    },
  };
}
