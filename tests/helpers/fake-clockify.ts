import type {
  EntitySummary,
  ProjectSummary,
  TaskSummary,
  TimeEntrySummary,
  WorkspaceClient,
} from "../../src/clockify/client.js";
import type {
  InvoiceDetail,
  InvoiceItem,
  InvoicePayment,
  InvoiceSummary,
} from "../../src/clockify/ports/invoices.js";
import type {
  ExpenseSummary,
  ExpenseCategorySummary,
} from "../../src/clockify/ports/expenses.js";
import type { CustomFieldSummary } from "../../src/clockify/ports/custom-fields.js";
import type {
  TimeOffPolicySummary,
  TimeOffRequestSummary,
  TimeOffBalanceSummary,
} from "../../src/clockify/ports/time-off.js";
import type { HolidaySummary } from "../../src/clockify/ports/holidays.js";
import type { AssignmentSummary } from "../../src/clockify/ports/scheduling.js";
import type { ApprovalSummary } from "../../src/clockify/ports/approvals.js";

/**
 * In-memory fake of the Clockify WorkspaceClient port for deterministic tests.
 * Tracks per-method call counts so tests can assert "called once" / "not called".
 */
export interface FakeWorkspaceSeed {
  tags?: EntitySummary[];
  clients?: EntitySummary[];
  projects?: ProjectSummary[];
  tasks?: TaskSummary[];
  running?: TimeEntrySummary | null;
  entries?: TimeEntrySummary[];
  expenses?: ExpenseSummary[];
  expenseCategories?: ExpenseCategorySummary[];
  users?: EntitySummary[];
  webhooks?: EntitySummary[];
  invoices?: InvoiceDetail[];
  customFields?: CustomFieldSummary[];
  timeOffPolicies?: TimeOffPolicySummary[];
  timeOffRequests?: TimeOffRequestSummary[];
  timeOffBalances?: TimeOffBalanceSummary[];
  holidays?: HolidaySummary[];
  assignments?: AssignmentSummary[];
  approvals?: ApprovalSummary[];
  /** deleteEntity throws for these ids (used to exercise partial batch failure). */
  failDeleteIds?: string[];
}

export interface FakeWorkspace {
  client: WorkspaceClient;
  counts: Record<string, number>;
  state: {
    tags: EntitySummary[];
    clients: EntitySummary[];
    projects: ProjectSummary[];
    tasks: TaskSummary[];
    timeEntries: TimeEntrySummary[];
    running: TimeEntrySummary | null;
    expenses: ExpenseSummary[];
    expenseCategories: ExpenseCategorySummary[];
    users: EntitySummary[];
    webhooks: EntitySummary[];
    invoices: InvoiceDetail[];
    invoicePayments: Record<string, InvoicePayment[]>;
    customFields: CustomFieldSummary[];
    timeOffPolicies: TimeOffPolicySummary[];
    timeOffRequests: TimeOffRequestSummary[];
    timeOffBalances: TimeOffBalanceSummary[];
    holidays: HolidaySummary[];
    assignments: AssignmentSummary[];
    approvals: ApprovalSummary[];
    deleted: Array<{ entityType: string; id: string }>;
  };
}

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

export function createFakeWorkspace(seed: FakeWorkspaceSeed = {}): FakeWorkspace {
  const state: FakeWorkspace["state"] = {
    tags: [...(seed.tags ?? [])],
    clients: [...(seed.clients ?? [])],
    projects: [...(seed.projects ?? [])],
    tasks: [...(seed.tasks ?? [])],
    timeEntries: [...(seed.entries ?? [])],
    running: seed.running ?? null,
    expenses: [...(seed.expenses ?? [])],
    expenseCategories: [...(seed.expenseCategories ?? [])],
    users: [...(seed.users ?? [])],
    webhooks: [...(seed.webhooks ?? [])],
    invoices: (seed.invoices ?? []).map((inv) => ({ ...inv, items: [...(inv.items ?? [])] })),
    invoicePayments: {},
    customFields: [...(seed.customFields ?? [])],
    timeOffPolicies: [...(seed.timeOffPolicies ?? [])],
    timeOffRequests: [...(seed.timeOffRequests ?? [])],
    timeOffBalances: [...(seed.timeOffBalances ?? [])],
    holidays: [...(seed.holidays ?? [])],
    assignments: [...(seed.assignments ?? [])],
    approvals: [...(seed.approvals ?? [])],
    deleted: [],
  };
  const counts: Record<string, number> = {};
  const bump = (method: string): void => {
    counts[method] = (counts[method] ?? 0) + 1;
  };

  const client: WorkspaceClient = {
    async listTags(filter) {
      bump("listTags");
      let rows = state.tags;
      if (filter?.name) {
        const needle = filter.name.toLowerCase();
        rows = rows.filter((t) => t.name.toLowerCase().includes(needle));
      }
      if (filter?.archived !== undefined) {
        rows = rows.filter((t) => Boolean(t.archived) === filter.archived);
      }
      return rows;
    },
    async getTag(id) {
      bump("getTag");
      return state.tags.find((t) => t.id === id) ?? null;
    },
    async createTag({ name }) {
      bump("createTag");
      const tag = { id: nextId("tag"), name };
      state.tags.push(tag);
      return tag;
    },
    async updateTag(id, patch) {
      bump("updateTag");
      const index = state.tags.findIndex((t) => t.id === id);
      const base: EntitySummary = index >= 0 ? state.tags[index] : { id, name: id };
      const updated: EntitySummary = {
        ...base,
        ...(typeof patch.name === "string" ? { name: patch.name } : {}),
        ...(typeof patch.archived === "boolean" ? { archived: patch.archived } : {}),
      };
      if (index >= 0) state.tags[index] = updated;
      else state.tags.push(updated);
      return updated;
    },
    async deleteTag(id) {
      bump("deleteTag");
      state.tags = state.tags.filter((t) => t.id !== id);
      state.deleted.push({ entityType: "tag", id });
    },
    async listClients(filter) {
      bump("listClients");
      let rows = state.clients;
      if (filter?.name) {
        const needle = filter.name.toLowerCase();
        rows = rows.filter((c) => c.name.toLowerCase().includes(needle));
      }
      if (filter?.archived !== undefined) {
        rows = rows.filter((c) => Boolean(c.archived) === filter.archived);
      }
      return rows;
    },
    async getClient(id) {
      bump("getClient");
      return state.clients.find((c) => c.id === id) ?? null;
    },
    async createClient({ name }) {
      bump("createClient");
      const c = { id: nextId("client"), name };
      state.clients.push(c);
      return c;
    },
    async updateClient(id, patch) {
      bump("updateClient");
      const index = state.clients.findIndex((c) => c.id === id);
      const base: EntitySummary = index >= 0 ? state.clients[index] : { id, name: id };
      const updated: EntitySummary = {
        ...base,
        ...(typeof patch.name === "string" ? { name: patch.name } : {}),
        ...(typeof patch.archived === "boolean" ? { archived: patch.archived } : {}),
      };
      if (index >= 0) state.clients[index] = updated;
      else state.clients.push(updated);
      return updated;
    },
    async deleteClient(id) {
      bump("deleteClient");
      state.clients = state.clients.filter((c) => c.id !== id);
      state.deleted.push({ entityType: "client", id });
    },
    async listProjects(filter) {
      bump("listProjects");
      let rows = state.projects;
      if (filter?.name) {
        const needle = filter.name.toLowerCase();
        rows = rows.filter((p) => p.name.toLowerCase().includes(needle));
      }
      if (filter?.archived !== undefined) {
        rows = rows.filter((p) => Boolean(p.archived) === filter.archived);
      }
      if (filter?.clientIds?.length) {
        rows = rows.filter((p) => p.clientId !== undefined && filter.clientIds?.includes(p.clientId));
      }
      return rows;
    },
    async getProject(id) {
      bump("getProject");
      return state.projects.find((p) => p.id === id) ?? null;
    },
    async createProject({ name, clientId }) {
      bump("createProject");
      const p: ProjectSummary = { id: nextId("project"), name, clientId };
      state.projects.push(p);
      return p;
    },
    async updateProject(id, patch) {
      bump("updateProject");
      const index = state.projects.findIndex((p) => p.id === id);
      const base: ProjectSummary = index >= 0 ? state.projects[index] : { id, name: id };
      const updated: ProjectSummary = {
        ...base,
        ...(typeof patch.name === "string" ? { name: patch.name } : {}),
        ...(typeof patch.clientId === "string" ? { clientId: patch.clientId } : {}),
        ...(typeof patch.archived === "boolean" ? { archived: patch.archived } : {}),
      };
      if (index >= 0) state.projects[index] = updated;
      else state.projects.push(updated);
      return updated;
    },
    async archiveProject(id) {
      bump("archiveProject");
      const index = state.projects.findIndex((p) => p.id === id);
      const base: ProjectSummary = index >= 0 ? state.projects[index] : { id, name: id };
      const archived: ProjectSummary = { ...base, archived: true };
      if (index >= 0) state.projects[index] = archived;
      else state.projects.push(archived);
      return archived;
    },
    async deleteProject(id) {
      bump("deleteProject");
      state.projects = state.projects.filter((p) => p.id !== id);
      state.deleted.push({ entityType: "project", id });
    },
    async createProjectFromTemplate({ templateId, name }) {
      bump("createProjectFromTemplate");
      const p: ProjectSummary = { id: nextId("project"), name: name ?? `from-${templateId}` };
      state.projects.push(p);
      return p;
    },
    async updateProjectRate(input) {
      bump("updateProjectRate");
      void input;
    },
    async updateProjectEstimate(id, patch) {
      bump("updateProjectEstimate");
      void id;
      void patch;
    },
    async updateProjectMemberships(id, patch) {
      bump("updateProjectMemberships");
      void id;
      void patch;
    },
    async listTasks(projectId, filter) {
      bump("listTasks");
      let rows = state.tasks.filter((t) => t.projectId === projectId);
      if (filter?.name) {
        const needle = filter.name.toLowerCase();
        rows = rows.filter((t) => t.name.toLowerCase().includes(needle));
      }
      return rows;
    },
    async getTask(projectId, id) {
      bump("getTask");
      return state.tasks.find((t) => t.projectId === projectId && t.id === id) ?? null;
    },
    async createTask({ projectId, name }) {
      bump("createTask");
      const t: TaskSummary = { id: nextId("task"), name, projectId };
      state.tasks.push(t);
      return t;
    },
    async updateTask(projectId, id, patch) {
      bump("updateTask");
      const index = state.tasks.findIndex((t) => t.projectId === projectId && t.id === id);
      const base: TaskSummary = index >= 0 ? state.tasks[index] : { id, name: id, projectId };
      const updated: TaskSummary = {
        ...base,
        ...(typeof patch.name === "string" ? { name: patch.name } : {}),
      };
      if (index >= 0) state.tasks[index] = updated;
      else state.tasks.push(updated);
      return updated;
    },
    async deleteTask(projectId, id) {
      bump("deleteTask");
      state.tasks = state.tasks.filter((t) => !(t.projectId === projectId && t.id === id));
      state.deleted.push({ entityType: "task", id });
    },
    async updateTaskRate(input) {
      bump("updateTaskRate");
      void input;
    },
    async getRunningTimeEntry() {
      bump("getRunningTimeEntry");
      return state.running;
    },
    async startTimeEntry(input) {
      bump("startTimeEntry");
      const entry: TimeEntrySummary = {
        id: nextId("entry"),
        description: input.description,
        projectId: input.projectId,
        taskId: input.taskId,
        tagIds: input.tagIds,
        billable: input.billable,
        start: input.start,
      };
      state.running = entry;
      state.timeEntries.push(entry);
      return entry;
    },
    async stopTimeEntry({ end }) {
      bump("stopTimeEntry");
      if (!state.running) return null;
      const stopped: TimeEntrySummary = { ...state.running, end };
      state.running = null;
      return stopped;
    },
    async createTimeEntry(input) {
      bump("createTimeEntry");
      const entry: TimeEntrySummary = {
        id: nextId("entry"),
        description: input.description,
        projectId: input.projectId,
        taskId: input.taskId,
        tagIds: input.tagIds,
        billable: input.billable,
        start: input.start,
        end: input.end ?? null,
      };
      state.timeEntries.push(entry);
      return entry;
    },
    async getEntries({ start, end, projectId, taskId }) {
      bump("getEntries");
      // ISO-8601 UTC strings sort lexicographically, so range filtering works.
      return state.timeEntries.filter((e) => {
        if (start && e.start < start) return false;
        if (end && e.start >= end) return false;
        if (projectId && e.projectId !== projectId) return false;
        if (taskId && e.taskId !== taskId) return false;
        return true;
      });
    },
    async getEntry(id) {
      bump("getEntry");
      return state.timeEntries.find((e) => e.id === id) ?? null;
    },
    async markEntriesInvoiced(input) {
      bump("markEntriesInvoiced");
      void input;
    },
    async updateTimeEntry({ id, description, projectId, taskId, tagIds }) {
      bump("updateTimeEntry");
      const index = state.timeEntries.findIndex((e) => e.id === id);
      const base: TimeEntrySummary =
        index >= 0 ? state.timeEntries[index] : { id, start: "" };
      const updated: TimeEntrySummary = {
        ...base,
        description: description ?? base.description,
        projectId: projectId ?? base.projectId,
        taskId: taskId ?? base.taskId,
        tagIds: tagIds ?? base.tagIds,
      };
      if (index >= 0) state.timeEntries[index] = updated;
      else state.timeEntries.push(updated);
      return updated;
    },
    async listExpenses() {
      bump("listExpenses");
      return state.expenses;
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
    async listExpenseCategories() {
      bump("listExpenseCategories");
      return state.expenseCategories;
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
    async deleteExpenseCategory(id) {
      bump("deleteExpenseCategory");
      state.expenseCategories = state.expenseCategories.filter((c) => c.id !== id);
      state.deleted.push({ entityType: "expense_category", id });
    },
    async listCustomFields() {
      bump("listCustomFields");
      return state.customFields;
    },
    async getCustomField(id) {
      bump("getCustomField");
      return state.customFields.find((c) => c.id === id) ?? null;
    },
    async createCustomField(input) {
      bump("createCustomField");
      const field: CustomFieldSummary = {
        id: nextId("cf"),
        name: input.name,
        type: input.type,
        status: input.status ?? "VISIBLE",
        required: input.required,
        allowedValues: input.allowedValues,
      };
      state.customFields.push(field);
      return { id: field.id, name: field.name };
    },
    async updateCustomField(id, patch) {
      bump("updateCustomField");
      const index = state.customFields.findIndex((c) => c.id === id);
      const base: CustomFieldSummary = index >= 0 ? state.customFields[index] : { id, name: id };
      const updated: CustomFieldSummary = {
        ...base,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.required !== undefined ? { required: patch.required } : {}),
        ...(patch.allowedValues !== undefined ? { allowedValues: patch.allowedValues } : {}),
      };
      if (index >= 0) state.customFields[index] = updated;
      else state.customFields.push(updated);
      return { id, name: updated.name };
    },
    async deleteCustomField(id) {
      bump("deleteCustomField");
      state.customFields = state.customFields.filter((c) => c.id !== id);
      state.deleted.push({ entityType: "custom_field", id });
    },
    async setProjectCustomFieldValue(projectId, fieldId, value) {
      bump("setProjectCustomFieldValue");
      void projectId;
      void fieldId;
      void value;
    },
    async setEntryCustomFieldValue(entryId, fieldId, value) {
      bump("setEntryCustomFieldValue");
      void entryId;
      void fieldId;
      void value;
    },
    async listUsers() {
      bump("listUsers");
      return state.users;
    },
    async listWebhooks() {
      bump("listWebhooks");
      return state.webhooks;
    },
    async deleteEntity(input) {
      bump("deleteEntity");
      if ((seed.failDeleteIds ?? []).includes(input.id)) {
        throw new Error(`Clockify refused to delete ${input.entityType} ${input.id}`);
      }
      state.deleted.push(input);
    },
    async listInvoices(filter) {
      bump("listInvoices");
      const rows = filter?.status
        ? state.invoices.filter((i) => i.status === filter.status)
        : state.invoices;
      return rows.map((inv): InvoiceSummary => {
        const { items: _items, ...summary } = inv;
        void _items;
        return summary;
      });
    },
    async getInvoice(id) {
      bump("getInvoice");
      return state.invoices.find((i) => i.id === id) ?? null;
    },
    async listInvoiceItems(id) {
      bump("listInvoiceItems");
      return state.invoices.find((i) => i.id === id)?.items ?? [];
    },
    async listInvoicePayments(id) {
      bump("listInvoicePayments");
      return state.invoicePayments[id] ?? [];
    },
    async exportInvoice(id) {
      bump("exportInvoice");
      void id;
      return { contentType: "application/pdf", bytes: 4, base64: "JVBERg==", truncated: false };
    },
    async createInvoice(input) {
      bump("createInvoice");
      const invoice: InvoiceDetail = {
        id: nextId("invoice"),
        number: input.number,
        clientId: input.clientId,
        currency: input.currency,
        status: "UNSENT",
        items: [],
      };
      state.invoices.push(invoice);
      return { id: invoice.id, name: invoice.number ?? invoice.id };
    },
    async updateInvoice(id, { patch, status }) {
      bump("updateInvoice");
      const index = state.invoices.findIndex((i) => i.id === id);
      if (index >= 0) {
        const base = state.invoices[index];
        state.invoices[index] = {
          ...base,
          ...(patch ?? {}),
          ...(status ? { status } : {}),
        } as InvoiceDetail;
        return { id, name: state.invoices[index].number ?? id };
      }
      return { id, name: id };
    },
    async deleteInvoice(id) {
      bump("deleteInvoice");
      state.invoices = state.invoices.filter((i) => i.id !== id);
      delete state.invoicePayments[id];
      state.deleted.push({ entityType: "invoice", id });
    },
    async addInvoiceItem(id, item) {
      bump("addInvoiceItem");
      const invoice = state.invoices.find((i) => i.id === id);
      if (invoice) {
        const line: InvoiceItem = {
          order: invoice.items.length,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPriceMinor,
          itemType: item.itemType,
        };
        invoice.items.push(line);
      }
    },
    async deleteInvoiceItem(id, index) {
      bump("deleteInvoiceItem");
      const invoice = state.invoices.find((i) => i.id === id);
      if (invoice) invoice.items = invoice.items.filter((it) => it.order !== index);
    },
    async createInvoicePayment(id, payment) {
      bump("createInvoicePayment");
      const record: InvoicePayment = {
        id: nextId("pay"),
        amount: payment.amountMinor,
        note: payment.note,
        paymentDate: payment.paymentDate,
      };
      (state.invoicePayments[id] ??= []).push(record);
      return record;
    },
    async deleteInvoicePayment(id, paymentId) {
      bump("deleteInvoicePayment");
      state.invoicePayments[id] = (state.invoicePayments[id] ?? []).filter((p) => p.id !== paymentId);
    },
    async importInvoiceTime(id, range) {
      bump("importInvoiceTime");
      void id;
      void range;
    },
    async manageWebhook(input) {
      bump("manageWebhook");
      if (input.operation === "delete") return null;
      return { id: input.id ?? nextId("webhook"), name: input.name ?? "webhook" };
    },
    async updateEntity(input) {
      bump("updateEntity");
      const name = (input.fields?.name as string | undefined) ?? input.id;
      return { id: input.id, name };
    },
    async listTimeOffPolicies() {
      bump("listTimeOffPolicies");
      return state.timeOffPolicies;
    },
    async getTimeOffPolicy(id) {
      bump("getTimeOffPolicy");
      return state.timeOffPolicies.find((p) => p.id === id) ?? null;
    },
    async createTimeOffPolicy(input) {
      bump("createTimeOffPolicy");
      const policy: TimeOffPolicySummary = { id: nextId("pol"), name: input.name, status: "ACTIVE", timeUnit: "DAYS" };
      state.timeOffPolicies.push(policy);
      return { id: policy.id, name: policy.name };
    },
    async updateTimeOffPolicy(id, patch) {
      bump("updateTimeOffPolicy");
      const index = state.timeOffPolicies.findIndex((p) => p.id === id);
      const base: TimeOffPolicySummary = index >= 0 ? state.timeOffPolicies[index] : { id, name: id };
      const updated: TimeOffPolicySummary = { ...base, ...(patch.name !== undefined ? { name: patch.name } : {}) };
      if (index >= 0) state.timeOffPolicies[index] = updated;
      else state.timeOffPolicies.push(updated);
      return { id, name: updated.name };
    },
    async archiveTimeOffPolicy(id, archived) {
      bump("archiveTimeOffPolicy");
      const policy = state.timeOffPolicies.find((p) => p.id === id);
      if (policy) policy.status = archived ? "ARCHIVED" : "ACTIVE";
    },
    async listTimeOffRequests(filter) {
      bump("listTimeOffRequests");
      let rows = state.timeOffRequests;
      if (filter?.status) rows = rows.filter((r) => r.status === filter.status);
      if (filter?.userId) rows = rows.filter((r) => r.userId === filter.userId);
      return rows;
    },
    async getTimeOffRequest(id) {
      bump("getTimeOffRequest");
      return state.timeOffRequests.find((r) => r.id === id) ?? null;
    },
    async createTimeOffRequest(policyId, input) {
      bump("createTimeOffRequest");
      const req: TimeOffRequestSummary = {
        id: nextId("tor"),
        policyId,
        status: "PENDING",
        note: input.note,
        start: input.start,
        end: input.end,
      };
      state.timeOffRequests.push(req);
      return { id: req.id, name: req.id };
    },
    async deleteTimeOffRequest(policyId, requestId) {
      bump("deleteTimeOffRequest");
      void policyId;
      state.timeOffRequests = state.timeOffRequests.filter((r) => r.id !== requestId);
      state.deleted.push({ entityType: "time_off_request", id: requestId });
    },
    async setTimeOffRequestStatus(policyId, requestId, statusType, note) {
      bump("setTimeOffRequestStatus");
      void policyId;
      void note;
      const req = state.timeOffRequests.find((r) => r.id === requestId);
      if (req) req.status = statusType;
      return { id: requestId, name: statusType };
    },
    async getTimeOffBalance(userId) {
      bump("getTimeOffBalance");
      return state.timeOffBalances.map((b) => ({ ...b, userId }));
    },
    async updateTimeOffBalance(policyId, input) {
      bump("updateTimeOffBalance");
      void policyId;
      void input;
    },
    async listHolidays() {
      bump("listHolidays");
      return state.holidays;
    },
    async getHoliday(id) {
      bump("getHoliday");
      return state.holidays.find((h) => h.id === id) ?? null;
    },
    async listHolidaysInPeriod(input) {
      bump("listHolidaysInPeriod");
      void input;
      return state.holidays;
    },
    async createHoliday(input) {
      bump("createHoliday");
      const holiday: HolidaySummary = {
        id: nextId("hol"),
        name: input.name,
        startDate: input.startDate,
        endDate: input.endDate ?? input.startDate,
        occursAnnually: input.occursAnnually,
      };
      state.holidays.push(holiday);
      return { id: holiday.id, name: holiday.name };
    },
    async updateHoliday(id, patch) {
      bump("updateHoliday");
      const index = state.holidays.findIndex((h) => h.id === id);
      const base: HolidaySummary = index >= 0 ? state.holidays[index] : { id, name: id };
      const updated: HolidaySummary = {
        ...base,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.startDate !== undefined ? { startDate: patch.startDate } : {}),
        ...(patch.endDate !== undefined ? { endDate: patch.endDate } : {}),
        ...(patch.occursAnnually !== undefined ? { occursAnnually: patch.occursAnnually } : {}),
      };
      if (index >= 0) state.holidays[index] = updated;
      else state.holidays.push(updated);
      return { id, name: updated.name };
    },
    async deleteHoliday(id) {
      bump("deleteHoliday");
      state.holidays = state.holidays.filter((h) => h.id !== id);
      state.deleted.push({ entityType: "holiday", id });
    },
    async listAssignments(filter) {
      bump("listAssignments");
      let rows = state.assignments;
      if (filter?.userId) rows = rows.filter((a) => a.userId === filter.userId);
      if (filter?.projectId) rows = rows.filter((a) => a.projectId === filter.projectId);
      return rows;
    },
    async getAssignment(id) {
      bump("getAssignment");
      return state.assignments.find((a) => a.id === id) ?? null;
    },
    async createAssignment(input) {
      bump("createAssignment");
      const a: AssignmentSummary = {
        id: nextId("asg"),
        userId: input.userId,
        projectId: input.projectId,
        start: input.start,
        end: input.end,
        hoursPerDay: input.hoursPerDay,
        note: input.note,
        published: false,
      };
      state.assignments.push(a);
      return { id: a.id, name: a.id };
    },
    async updateAssignment(id, patch) {
      bump("updateAssignment");
      const a = state.assignments.find((x) => x.id === id);
      if (a) {
        if (patch.hoursPerDay !== undefined) a.hoursPerDay = patch.hoursPerDay;
        if (patch.note !== undefined) a.note = patch.note;
      }
      return { id, name: id };
    },
    async deleteAssignment(id, seriesUpdateOption) {
      bump("deleteAssignment");
      void seriesUpdateOption;
      state.assignments = state.assignments.filter((a) => a.id !== id);
      state.deleted.push({ entityType: "assignment", id });
    },
    async publishSchedule(input) {
      bump("publishSchedule");
      void input;
    },
    async getProjectScheduleTotals(input) {
      bump("getProjectScheduleTotals");
      void input;
      return [];
    },
    async getUserScheduleTotals(userId, range) {
      bump("getUserScheduleTotals");
      void range;
      return { userId };
    },
    async listApprovals(filter) {
      bump("listApprovals");
      return filter?.status ? state.approvals.filter((a) => a.state === filter.status) : state.approvals;
    },
    async getApproval(id) {
      bump("getApproval");
      return state.approvals.find((a) => a.id === id) ?? null;
    },
    async submitApproval(input) {
      bump("submitApproval");
      const a: ApprovalSummary = { id: nextId("ap"), state: "PENDING", periodStart: input.periodStart };
      state.approvals.push(a);
      return { id: a.id, name: a.id };
    },
    async setApprovalState(id, st, note) {
      bump("setApprovalState");
      void note;
      const a = state.approvals.find((x) => x.id === id);
      if (a) a.state = st;
      return { id, name: st };
    },
    async resubmitApproval(id, entryIds, note) {
      bump("resubmitApproval");
      void entryIds;
      void note;
      return { id, name: "resubmitted" };
    },
  };

  return { client, counts, state };
}
