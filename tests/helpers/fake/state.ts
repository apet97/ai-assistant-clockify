import type {
  EntitySummary,
  ProjectSummary,
  TaskSummary,
  TimeEntrySummary,
} from "../../../src/clockify/client.js";
import type {
  InvoiceDetail,
  InvoicePayment,
} from "../../../src/clockify/ports/invoices.js";
import type {
  ExpenseSummary,
  ExpenseCategorySummary,
} from "../../../src/clockify/ports/expenses.js";
import type { CustomFieldSummary } from "../../../src/clockify/ports/custom-fields.js";
import type {
  TimeOffPolicySummary,
  TimeOffRequestSummary,
  TimeOffBalanceSummary,
} from "../../../src/clockify/ports/time-off.js";
import type { HolidaySummary } from "../../../src/clockify/ports/holidays.js";
import type { AssignmentSummary } from "../../../src/clockify/ports/scheduling.js";
import type { ApprovalSummary } from "../../../src/clockify/ports/approvals.js";
import type { WebhookSummary } from "../../../src/clockify/ports/webhooks.js";
import type { UserSummary, GroupSummary, CalendarContext, UserRoleAssignment, WorkspaceMemberRateSnapshot } from "../../../src/clockify/ports/users.js";
import type { ListResult } from "../../../src/clockify/types.js";

export type FakeListFamily =
  | "listApprovals"
  | "searchAuditLog"
  | "listEntityChanges"
  | "listClients"
  | "listCurrencies"
  | "listCustomFields"
  | "listExpenses"
  | "listExpenseCategories"
  | "listHolidays"
  | "listHolidaysInPeriod"
  | "listInvoices"
  | "listInvoiceItems"
  | "listInvoicePayments"
  | "listProjects"
  | "getProjectMemberships"
  | "listAssignments"
  | "getProjectScheduleTotals"
  | "getAllProjectScheduleTotals"
  | "getOneProjectScheduleTotals"
  | "listTags"
  | "listTasks"
  | "getEntries"
  | "listTimeOffPolicies"
  | "listTimeOffRequests"
  | "getTimeOffBalance"
  | "listUsers"
  | "listGroups"
  | "listWebhooks"
  | "listWebhookEvents"
  | "listWebhookLogs"
  | "listTemplates";

export type FakeInvoiceMutation =
  | "createInvoiceBase"
  | "updateInvoiceFields"
  | "updateInvoiceStatus"
  | "deleteInvoiceAtomic"
  | "addInvoiceItemAtomic"
  | "deleteInvoiceItemAtomic"
  | "createInvoicePaymentAtomic"
  | "deleteInvoicePaymentAtomic"
  | "importInvoiceTimeAtomic";

export interface FakeInvoiceFault {
  outcome: "definitive" | "ambiguous";
  /** Simulate a socket close after Clockify applied the request. */
  applyBeforeThrow?: boolean;
}

/**
 * Shape of the seed accepted by the fake. Re-exported through `fake-clockify.ts`.
 */
export interface FakeWorkspaceSeed {
  tags?: EntitySummary[];
  clients?: EntitySummary[];
  /** Workspace currencies (for client currency-by-code resolution). */
  currencies?: Array<{ id: string; code: string }>;
  projects?: ProjectSummary[];
  tasks?: TaskSummary[];
  running?: TimeEntrySummary | null;
  entries?: TimeEntrySummary[];
  expenses?: ExpenseSummary[];
  expenseCategories?: ExpenseCategorySummary[];
  users?: UserSummary[];
  /** Per-user workspace role for the opt-in admin re-check (authz-surface-01). */
  memberRoles?: Record<string, string>;
  userRoleAssignments?: Record<string, UserRoleAssignment[]>;
  workspaceMemberRates?: Record<string, Partial<Record<"HOURLY" | "COST", Omit<WorkspaceMemberRateSnapshot, "userId" | "rateKind">>>>;
  calendarContext?: CalendarContext;
  groups?: GroupSummary[];
  webhooks?: WebhookSummary[];
  invoices?: InvoiceDetail[];
  customFields?: CustomFieldSummary[];
  timeOffPolicies?: TimeOffPolicySummary[];
  timeOffRequests?: TimeOffRequestSummary[];
  timeOffBalances?: TimeOffBalanceSummary[];
  holidays?: HolidaySummary[];
  assignments?: AssignmentSummary[];
  approvals?: ApprovalSummary[];
  /** Per-project membership records (mirrors ProjectDtoV1.memberships). */
  projectMemberships?: Record<string, Array<Record<string, unknown>>>;
  /** Stateful custom-field values keyed by project id then field id. */
  projectCustomFieldValues?: Record<string, Record<string, unknown>>;
  /** Stateful custom-field values keyed by time-entry id then field id. */
  entryCustomFieldValues?: Record<string, Record<string, unknown>>;
  /** deleteEntity throws for these ids (used to exercise partial batch failure). */
  failDeleteIds?: string[];
  /** Per-family completeness controls (simulates a pagination/search backstop). */
  listTruncated?: Partial<Record<FakeListFamily, boolean>>;
  /** addInvoiceItem throws (simulates a workspace with no matching invoice item type). */
  failAddInvoiceItem?: boolean;
  /** Per-atomic-mutation durable outcome injection. */
  invoiceFaults?: Partial<Record<FakeInvoiceMutation, FakeInvoiceFault>>;
  /** Return a malformed successful invoice-create response with no id. */
  omitCreatedInvoiceId?: boolean;
  /** Rows injected after payment POST to model concurrent payments. */
  concurrentInvoicePayments?: InvoicePayment[];
  /** Throw on payment reads after the first payment POST. */
  failPaymentReadAfterPost?: boolean;
}

/** The mutable in-memory state the fake holds. */
export interface FakeState {
  tags: EntitySummary[];
  clients: EntitySummary[];
  currencies: Array<{ id: string; code: string }>;
  projects: ProjectSummary[];
  tasks: TaskSummary[];
  timeEntries: TimeEntrySummary[];
  running: TimeEntrySummary | null;
  expenses: ExpenseSummary[];
  expenseCategories: ExpenseCategorySummary[];
  users: UserSummary[];
  memberRoles: Record<string, string>;
  userRoleAssignments: Record<string, UserRoleAssignment[]>;
  workspaceMemberRates: Record<string, Partial<Record<"HOURLY" | "COST", Omit<WorkspaceMemberRateSnapshot, "userId" | "rateKind">>>>;
  calendarContext: CalendarContext;
  groups: GroupSummary[];
  webhooks: WebhookSummary[];
  invoices: InvoiceDetail[];
  invoicePayments: Record<string, InvoicePayment[]>;
  customFields: CustomFieldSummary[];
  timeOffPolicies: TimeOffPolicySummary[];
  timeOffRequests: TimeOffRequestSummary[];
  timeOffBalances: TimeOffBalanceSummary[];
  holidays: HolidaySummary[];
  assignments: AssignmentSummary[];
  approvals: ApprovalSummary[];
  projectMemberships: Record<string, Array<Record<string, unknown>>>;
  projectCustomFieldValues: Record<string, Record<string, unknown>>;
  entryCustomFieldValues: Record<string, Record<string, unknown>>;
  deleted: Array<{ entityType: string; id: string }>;
}

/**
 * Context passed to every area factory: the shared mutable state, the seed (for
 * failure-injection knobs read at call time), and the shared `bump`/`nextId`
 * helper closures so call counts and id generation stay global across areas.
 */
export interface FakeContext {
  state: FakeState;
  seed: FakeWorkspaceSeed;
  bump: (method: string) => void;
  nextId: (prefix: string) => string;
}

export function fakeListResult<T>(
  seed: FakeWorkspaceSeed,
  family: FakeListFamily,
  rows: T[],
): ListResult<T> {
  return { rows, truncated: seed.listTruncated?.[family] ?? false };
}

export function makeNextId(): (prefix: string) => string {
  let idSeq = 0;
  return (prefix: string): string => {
    idSeq += 1;
    return `${prefix}-${idSeq}`;
  };
}

/** Build mutable state from an already isolated workspace seed. */
export function createFakeState(seed: FakeWorkspaceSeed): FakeState {
  const source = seed;
  return {
    tags: source.tags ?? [],
    clients: source.clients ?? [],
    currencies: source.currencies ?? [],
    projects: source.projects ?? [],
    tasks: source.tasks ?? [],
    timeEntries: source.entries ?? [],
    running: source.running ?? null,
    expenses: source.expenses ?? [],
    expenseCategories: source.expenseCategories ?? [],
    users: source.users ?? [],
    memberRoles: source.memberRoles ?? {},
    userRoleAssignments: source.userRoleAssignments ?? {},
    workspaceMemberRates: source.workspaceMemberRates ?? {},
    calendarContext: source.calendarContext ?? { timeZone: "UTC", weekStartsOn: 1 },
    groups: source.groups ?? [],
    webhooks: source.webhooks ?? [],
    invoices: source.invoices ?? [],
    invoicePayments: {},
    customFields: source.customFields ?? [],
    timeOffPolicies: source.timeOffPolicies ?? [],
    timeOffRequests: source.timeOffRequests ?? [],
    timeOffBalances: source.timeOffBalances ?? [],
    holidays: source.holidays ?? [],
    assignments: source.assignments ?? [],
    approvals: source.approvals ?? [],
    projectMemberships: source.projectMemberships ?? {},
    projectCustomFieldValues: structuredClone(source.projectCustomFieldValues ?? {}),
    entryCustomFieldValues: structuredClone(source.entryCustomFieldValues ?? {}),
    deleted: [],
  };
}
