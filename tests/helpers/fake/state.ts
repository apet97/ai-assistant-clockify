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
import type { UserSummary, GroupSummary } from "../../../src/clockify/ports/users.js";

/**
 * Shape of the seed accepted by the fake. Re-exported through `fake-clockify.ts`.
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
  users?: UserSummary[];
  /** Per-user workspace role for the opt-in admin re-check (authz-surface-01). */
  memberRoles?: Record<string, string>;
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
  /** deleteEntity throws for these ids (used to exercise partial batch failure). */
  failDeleteIds?: string[];
  /** getEntries reports `truncated: true` (simulates the 10k pagination backstop). */
  entriesTruncated?: boolean;
  /** addInvoiceItem throws (simulates a workspace with no matching invoice item type). */
  failAddInvoiceItem?: boolean;
}

/** The mutable in-memory state the fake holds. */
export interface FakeState {
  tags: EntitySummary[];
  clients: EntitySummary[];
  projects: ProjectSummary[];
  tasks: TaskSummary[];
  timeEntries: TimeEntrySummary[];
  running: TimeEntrySummary | null;
  expenses: ExpenseSummary[];
  expenseCategories: ExpenseCategorySummary[];
  users: UserSummary[];
  memberRoles: Record<string, string>;
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

let idSeq = 0;
export function makeNextId(): (prefix: string) => string {
  return (prefix: string): string => {
    idSeq += 1;
    return `${prefix}-${idSeq}`;
  };
}

/** Build the initial mutable state from a seed (preserves prior cloning semantics). */
export function createFakeState(seed: FakeWorkspaceSeed): FakeState {
  return {
    tags: [...(seed.tags ?? [])],
    clients: [...(seed.clients ?? [])],
    projects: [...(seed.projects ?? [])],
    tasks: [...(seed.tasks ?? [])],
    timeEntries: [...(seed.entries ?? [])],
    running: seed.running ?? null,
    expenses: [...(seed.expenses ?? [])],
    expenseCategories: [...(seed.expenseCategories ?? [])],
    users: [...(seed.users ?? [])],
    memberRoles: { ...(seed.memberRoles ?? {}) },
    groups: [...(seed.groups ?? [])],
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
    projectMemberships: Object.fromEntries(
      Object.entries(seed.projectMemberships ?? {}).map(([id, rows]) => [id, [...rows]]),
    ),
    deleted: [],
  };
}
