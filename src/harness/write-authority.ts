import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  ActionDefinition,
  AuthoredIntentMetadata,
  ExternalMutationPlan,
  SemanticLiteralAlias,
  WriteAuthorityMetadata,
} from "./action.js";
import {
  APPROVAL_PENDING_BATCH_MAX,
  GROUP_MEMBER_BATCH_MAX,
  INVOICE_CREATE_MUTATION_STEP_MAX,
  INVOICE_IMPORT_PROJECT_BATCH_MAX,
  INVOICE_ITEM_BATCH_MAX,
  INTENT_LITERAL_LIMITS,
  MARK_INVOICED_ENTRY_BATCH_MAX,
  ONBOARD_GROUP_BATCH_MAX,
  ONBOARD_USER_MUTATION_STEP_MAX,
  SETUP_PROJECT_MUTATION_STEP_MAX,
  SETUP_PROJECT_RATE_BATCH_MAX,
  SETUP_TASK_ASSIGNEE_BATCH_MAX,
  TIME_OFF_BALANCE_USER_BATCH_MAX,
  TURN_HOST_CALL_LIMIT,
} from "./safety-limits.js";

interface JsonSchemaNode {
  type?: string | readonly string[];
  const?: unknown;
  enum?: readonly unknown[];
  properties?: Record<string, JsonSchemaNode>;
  required?: readonly string[];
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
}

type Cardinality = WriteAuthorityMetadata["cardinality"];

interface ActionAuthoritySemantics {
  /** Normalized operation paths populated only after authoritative resolution. */
  derivedIds?: readonly string[];
  /** Normalized operation paths the harness may populate when raw args omit them. */
  defaults?: readonly string[];
  /** Normalized operation paths copied unchanged from an authoritative host read. */
  preservedState?: readonly string[];
  /** Exact raw literal paths where `me` may become the authenticated admin id. */
  authenticatedSelfLiterals?: readonly string[];
  /** Maximum external mutation shape for one intent execution. */
  cardinality: Cardinality;
  mutationPlans: WriteAuthorityMetadata["mutationPlans"];
}

type PlanRule = WriteAuthorityMetadata["mutationPlans"][number];
type StepRule = PlanRule["steps"][number];

const step = (
  id: string,
  kind: StepRule["kind"] = "primary",
  min = 1,
  max = min,
): StepRule => ({ id, kind, min, max });
const plan = (mode: PlanRule["mode"], ...steps: StepRule[]): PlanRule => ({
  mode,
  minSteps: steps.reduce((total, rule) => total + rule.min, 0),
  maxSteps: steps.reduce((total, rule) => total + rule.max, 0),
  steps,
});
const single = (id: string, extras: Omit<ActionAuthoritySemantics, "cardinality" | "mutationPlans"> = {}): ActionAuthoritySemantics => ({
  ...extras,
  cardinality: { mode: "single", maxExecutions: 1 },
  mutationPlans: [plan("single", step(id))],
});
const fixed = (
  maxExecutions: number,
  mutationPlans: WriteAuthorityMetadata["mutationPlans"],
  extras: Omit<ActionAuthoritySemantics, "cardinality" | "mutationPlans"> = {},
): ActionAuthoritySemantics => ({ ...extras, cardinality: { mode: "fixed", maxExecutions }, mutationPlans });
const repeated = (
  maxExecutions: number,
  argumentPath: string,
  mutationPlans: WriteAuthorityMetadata["mutationPlans"],
  extras: Omit<ActionAuthoritySemantics, "cardinality" | "mutationPlans"> = {},
  maxArgumentItems = maxExecutions,
): ActionAuthoritySemantics => ({
  ...extras,
  cardinality: { mode: "argument", maxExecutions, maxArgumentItems, argumentPath },
  mutationPlans,
});
const local = (): ActionAuthoritySemantics => ({
  cardinality: { mode: "single", maxExecutions: 1 },
  mutationPlans: [],
});

/**
 * Action semantics are deliberately named here. Schema arrays describe values,
 * not host-call count: tagIds, ccEmails, and assigneeIds can all travel in one
 * request, while curated workflows can dispatch multiple exact plan steps.
 */
const ACTION_SEMANTICS = Object.freeze({
  assistant_update_permissions: local(),
  clockify_start_timer: single("start-timer", { derivedIds: ["operation.projectId", "operation.taskId", "operation.tagIds[]", "operation.body.projectId", "operation.body.taskId", "operation.body.tagIds[]", "operation.body.userId"], defaults: ["operation.body.start"] }),
  clockify_entries_create: single("create-time-entry", { derivedIds: ["operation.projectId", "operation.taskId", "operation.tagIds[]", "operation.body.projectId", "operation.body.taskId", "operation.body.tagIds[]"] }),
  clockify_entries_start: single("start-time-entry", { derivedIds: ["operation.projectId", "operation.taskId", "operation.tagIds[]", "operation.body.projectId", "operation.body.taskId", "operation.body.tagIds[]", "operation.body.userId"], defaults: ["operation.body.start"] }),
  clockify_stop_timer: single("stop-timer", { derivedIds: ["operation.entryId", "operation.userId"] }),
  clockify_log_work: single("log-time-entry", { derivedIds: ["operation.projectId", "operation.taskId", "operation.tagIds[]", "operation.body.projectId", "operation.body.taskId", "operation.body.tagIds[]"] }),
  clockify_fix_entry: single("update-time-entry", { derivedIds: ["operation.entryId", "operation.projectId", "operation.taskId", "operation.tagIds", "operation.tagIds[]", "operation.body.projectId", "operation.body.taskId", "operation.body.tagIds[]"], defaults: ["operation.body.start"] }),
  clockify_entries_update: single("update-time-entry", { derivedIds: ["operation.id", "operation.projectId", "operation.taskId", "operation.tagIds", "operation.tagIds[]", "operation.body.projectId", "operation.body.taskId", "operation.body.tagIds[]"], defaults: ["operation.body.start"] }),
  clockify_entries_delete: single("delete-time-entry", { derivedIds: ["operation.id"] }),
  clockify_entries_mark_invoiced: repeated(1, "ids[]", [plan("single", step("mark-entries-invoiced"))], { derivedIds: ["operation.entryIds[]"] }, MARK_INVOICED_ENTRY_BATCH_MAX),
  clockify_create_work_package: fixed(5, [
    ...["create-tag", "create-client", "create-project", "create-task", "start-timer"].map((id) => plan("single", step(id))),
    { ...plan("curated", step("create-tag", "primary", 0, 1), step("create-client", "primary", 0, 1), step("create-project", "primary", 0, 1), step("create-task", "primary", 0, 1), step("start-timer", "primary", 0, 1)), minSteps: 2 },
  ], { derivedIds: ["operation.clientId", "operation.projectId", "operation.taskId", "operation.tagId"], defaults: ["operation.timer.start"] }),
  clockify_projects_create: single("create-project", { derivedIds: ["operation.clientId", "operation.body.clientId"], defaults: ["operation.rateUnit", "operation.body.rateUnit"] }),
  clockify_projects_from_template: single("create-project-from-template", { derivedIds: ["operation.templateId", "operation.body.templateProjectId"] }),
  clockify_projects_update: single("update-project", { derivedIds: ["operation.id", "operation.projectId", "operation.clientId", "operation.body.clientId", "operation.patch.clientId"] }),
  clockify_projects_archive: single("archive-project", { derivedIds: ["operation.id", "operation.projectId"], defaults: ["operation.body.archived"] }),
  clockify_projects_delete: fixed(3, [
    plan("single", step("delete-project")),
    plan("curated", step("archive-project-for-delete"), step("delete-project"), step("restore-project", "compensation")),
  ], { derivedIds: ["operation.id", "operation.projectId"] }),
  clockify_projects_delete_archived: single("delete-archived-project", { derivedIds: ["operation.id", "operation.projectId"] }),
  clockify_projects_rate_update: single("update-project-rate", { derivedIds: ["operation.projectId", "operation.userId"], authenticatedSelfLiterals: ["userId"] }),
  clockify_projects_member_hourly_rate_update: single("update-project-member-hourly-rate", { derivedIds: ["operation.projectId", "operation.userId"], authenticatedSelfLiterals: ["userId"] }),
  clockify_projects_member_cost_rate_update: single("update-project-member-cost-rate", { derivedIds: ["operation.projectId", "operation.userId"], authenticatedSelfLiterals: ["userId"] }),
  clockify_projects_estimate_update: single("update-project-estimate", { derivedIds: ["operation.projectId"] }),
  clockify_projects_memberships_update: single("update-project-memberships", { derivedIds: ["operation.projectId", "operation.userIds[]", "operation.memberships[].userId"], authenticatedSelfLiterals: ["addUserIds[]"] }),
  clockify_projects_memberships_replace: single("replace-project-memberships", { derivedIds: ["operation.projectId", "operation.memberships[].userId"] }),
  clockify_tasks_create: single("create-task", { derivedIds: ["operation.projectId", "operation.assigneeIds[]", "operation.body.projectId", "operation.body.assigneeIds[]"] }),
  clockify_tasks_update: single("update-task", { derivedIds: ["operation.projectId", "operation.taskId", "operation.id", "operation.assigneeIds[]", "operation.body.projectId", "operation.body.assigneeIds[]", "operation.patch.assigneeIds[]"] }),
  clockify_tasks_delete: fixed(3, [
    plan("single", step("delete-task")),
    plan("curated", step("complete-task-for-delete"), step("delete-task"), step("restore-task-status", "compensation")),
  ], { derivedIds: ["operation.projectId", "operation.taskId", "operation.id", "operation.doneBody.projectId"] }),
  clockify_tasks_rate_update: single("update-task-rate", { derivedIds: ["operation.projectId", "operation.taskId"] }),
  clockify_tasks_delete_completed: single("delete-completed-task", { derivedIds: ["operation.projectId", "operation.taskId", "operation.id"] }),
  clockify_tasks_status_update: single("update-task-status", { derivedIds: ["operation.projectId", "operation.taskId", "operation.id", "operation.body.projectId"] }),
  clockify_tasks_assignees_replace: single("replace-task-assignees", { derivedIds: ["operation.projectId", "operation.taskId", "operation.id", "operation.assigneeIds[]", "operation.body.projectId", "operation.body.assigneeIds[]"] }),
  clockify_tasks_hourly_rate_update: single("update-task-hourly-rate", { derivedIds: ["operation.projectId", "operation.taskId"] }),
  clockify_tasks_cost_rate_update: single("update-task-cost-rate", { derivedIds: ["operation.projectId", "operation.taskId"] }),
  clockify_clients_create: fixed(2, [plan("single", step("create-client")), plan("curated", step("create-client"), step("enrich-client"))], { derivedIds: ["operation.enrichment.currencyId"] }),
  clockify_clients_create_base: single("create-client-base"),
  clockify_clients_update: single("update-client", { derivedIds: ["operation.clientId", "operation.id", "operation.body.currencyId", "operation.patch.currencyId"] }),
  clockify_clients_archive: single("archive-client", { derivedIds: ["operation.id"] }),
  clockify_clients_delete: fixed(3, [
    plan("single", step("delete-client")),
    plan("curated", step("archive-client"), step("delete-client"), step("restore-client", "compensation")),
  ], { derivedIds: ["operation.clientId", "operation.id"] }),
  clockify_clients_delete_archived: single("delete-archived-client", { derivedIds: ["operation.id"] }),
  clockify_tags_create: single("create-tag"),
  clockify_tags_update: single("update-tag", { derivedIds: ["operation.tagId", "operation.id"] }),
  clockify_tags_delete: single("delete-tag", { derivedIds: ["operation.tagId", "operation.id"] }),
  clockify_invoices_create: repeated(INVOICE_CREATE_MUTATION_STEP_MAX, "items[]", [
    plan("curated", step("create-invoice"), step("enrich-invoice", "primary", 0, 1), step("add-invoice-item-*", "primary", 0, INVOICE_ITEM_BATCH_MAX)),
  ], { derivedIds: ["operation.clientId", "operation.base.clientId", "operation.items[].itemType", "operation.items[].itemTypeId"], defaults: ["operation.number", "operation.base.number", "operation.issuedDate", "operation.base.issuedDate", "operation.dueDate", "operation.base.dueDate", "operation.currency", "operation.base.currency", "operation.items[].description", "operation.items[].quantity", "operation.items[].amountUnit", "operation.items[].applyTaxes"] }, INVOICE_ITEM_BATCH_MAX),
  clockify_invoices_update: fixed(2, [
    plan("curated", step("update-invoice-fields", "primary", 0, 1), step("update-invoice-status", "primary", 0, 1)),
  ], { derivedIds: ["operation.invoiceId", "operation.id", "operation.clientId", "operation.patch.clientId", "operation.updateBody.clientId"] }),
  clockify_invoices_delete: single("delete-invoice", { derivedIds: ["operation.invoiceId", "operation.id"] }),
  clockify_invoices_items_add: single("add-invoice-item", { derivedIds: ["operation.invoiceId", "operation.itemTypeId"], defaults: ["operation.unitPriceUnit"] }),
  clockify_invoices_items_delete: single("delete-invoice-item", { derivedIds: ["operation.invoiceId"] }),
  clockify_invoices_payments_create: single("record-payment", { derivedIds: ["operation.invoiceId"], defaults: ["operation.amountUnit"] }),
  clockify_invoices_payments_delete: single("delete-invoice-payment", { derivedIds: ["operation.invoiceId", "operation.paymentId"] }),
  clockify_invoices_import_time: repeated(1, "projectIds[]", [plan("single", step("import-invoice-time"))], { derivedIds: ["operation.invoiceId", "operation.projectId", "operation.userId", "operation.range.projectIds[]"] }, INVOICE_IMPORT_PROJECT_BATCH_MAX),
  clockify_expenses_create: single("create-expense", { derivedIds: ["operation.categoryId", "operation.projectId", "operation.taskId", "operation.userId", "operation.body.categoryId", "operation.body.projectId", "operation.body.taskId", "operation.body.userId", "operation.input.categoryId", "operation.input.projectId", "operation.input.taskId", "operation.input.userId"], defaults: ["operation.amountUnit", "operation.body.amountUnit"] }),
  clockify_expenses_update: single("update-expense", { derivedIds: ["operation.expenseId", "operation.id", "operation.categoryId", "operation.projectId", "operation.taskId", "operation.body.categoryId", "operation.body.projectId", "operation.body.taskId", "operation.updateBody.userId", "operation.updateBody.categoryId", "operation.updateBody.projectId", "operation.updateBody.taskId", "operation.values.categoryId", "operation.values.projectId", "operation.values.taskId"], defaults: ["operation.amountUnit", "operation.body.amountUnit"] }),
  clockify_expenses_delete: single("delete-expense", { derivedIds: ["operation.expenseId", "operation.id"] }),
  clockify_expenses_categories_create: single("create-expense-category"),
  clockify_expenses_categories_update: fixed(2, [
    plan("single", step("rename-expense-category")), plan("single", step("set-expense-category-status")),
    plan("curated", step("rename-expense-category"), step("set-expense-category-status")),
  ], { derivedIds: ["operation.categoryId", "operation.id"] }),
  clockify_expenses_categories_delete: fixed(2, [plan("single", step("delete-expense-category")), plan("curated", step("archive-expense-category"), step("delete-expense-category"))], { derivedIds: ["operation.categoryId", "operation.id"] }),
  clockify_custom_fields_create: single("create-custom-field", { derivedIds: ["operation.projectId"] }),
  clockify_custom_fields_update: single("update-custom-field", { derivedIds: ["operation.customFieldId", "operation.id"] }),
  clockify_custom_fields_delete: single("delete-custom-field", { derivedIds: ["operation.customFieldId", "operation.id"] }),
  clockify_custom_fields_set_value_project: single("set-project-custom-field", { derivedIds: ["operation.projectId", "operation.fieldId", "operation.customFieldId"] }),
  clockify_custom_fields_set_value_entry: single("set-entry-custom-field", { derivedIds: ["operation.entryId", "operation.fieldId", "operation.customFieldId", "operation.prepared.body.projectId", "operation.prepared.body.taskId", "operation.prepared.body.tagIds[]", "operation.prepared.body.customFieldValues[].customFieldId", "operation.prepared.source.projectId", "operation.prepared.source.taskId", "operation.prepared.source.tagIds[]", "operation.prepared.source.customFieldValues[].customFieldId"], defaults: ["operation.prepared.body.start", "operation.prepared.source.start"], preservedState: ["operation.prepared.body.description", "operation.prepared.source.description"] }),
  clockify_time_off_policies_create: single("create-time-off-policy", { derivedIds: ["operation.input.userId", "operation.input.userIds[]", "operation.input.userGroupIds[]"] }),
  clockify_time_off_policies_update: single("update-time-off-policy", { derivedIds: ["operation.policyId", "operation.id", "operation.patch.userIds[]", "operation.patch.userGroupIds[]", "operation.updateBody.userIds[]", "operation.updateBody.userGroupIds[]", "operation.updateBody.body.userIds[]", "operation.updateBody.body.userGroupIds[]", "operation.updateBody.source.userIds[]", "operation.updateBody.source.userGroupIds[]"] }),
  clockify_time_off_policies_archive: single("archive-time-off-policy", { derivedIds: ["operation.policyId", "operation.id"], defaults: ["operation.archived"] }),
  clockify_time_off_requests_create: single("create-time-off-request", { derivedIds: ["operation.policyId", "operation.userId"] }),
  clockify_time_off_requests_delete: single("delete-time-off-request", { derivedIds: ["operation.policyId", "operation.requestId", "operation.id"] }),
  clockify_time_off_approve: single("approve-time-off-request", { derivedIds: ["operation.policyId", "operation.requestId", "operation.id"] }),
  clockify_time_off_deny: single("deny-time-off-request", { derivedIds: ["operation.policyId", "operation.requestId", "operation.id"] }),
  clockify_time_off_balance_update: repeated(1, "userIds[]", [plan("single", step("update-time-off-balance"))], { derivedIds: ["operation.policyId", "operation.userIds[]", "operation.expectedBalances[].userId"] }, TIME_OFF_BALANCE_USER_BATCH_MAX),
  clockify_holidays_create: single("create-holiday", { derivedIds: ["operation.body.userIds[]", "operation.body.userGroupIds[]"] }),
  clockify_holidays_update: single("update-holiday", { derivedIds: ["operation.holidayId", "operation.id", "operation.body.userIds[]", "operation.body.userGroupIds[]", "operation.updateBody.userIds[]", "operation.updateBody.userGroupIds[]", "operation.updateBody.source.userIds[]", "operation.updateBody.source.userGroupIds[]"] }),
  clockify_holidays_delete: single("delete-holiday", { derivedIds: ["operation.holidayId", "operation.id"] }),
  clockify_scheduling_assignments_create: single("create-assignment", { derivedIds: ["operation.input.userId", "operation.input.projectId", "operation.filter.userId", "operation.filter.projectId"] }),
  clockify_scheduling_assignments_update: single("update-assignment", { derivedIds: ["operation.assignmentId", "operation.id", "operation.body.userId", "operation.body.projectId"], defaults: ["operation.body.start"] }),
  clockify_scheduling_assignments_delete: single("delete-assignment", { derivedIds: ["operation.assignmentId", "operation.id"] }),
  clockify_scheduling_publish: single("publish-schedule", { derivedIds: ["operation.userId", "operation.userFilter.userIds[]"] }),
  clockify_approvals_submit: single("submit-approval", { derivedIds: ["operation.userId"], defaults: ["operation.period"] }),
  clockify_approvals_approve: single("set-approval-state", { derivedIds: ["operation.approvalId", "operation.id"], defaults: ["operation.state"] }),
  clockify_approvals_approve_pending: fixed(APPROVAL_PENDING_BATCH_MAX, [
    plan("batch", step("approve-pending-*", "primary", 1, APPROVAL_PENDING_BATCH_MAX)),
  ], { derivedIds: ["operation.approvals[].id"], defaults: ["operation.approvals[].previousState"] }),
  clockify_approvals_reject: single("set-approval-state", { derivedIds: ["operation.approvalId", "operation.id"], defaults: ["operation.state"] }),
  clockify_approvals_withdraw: single("withdraw-approval", { derivedIds: ["operation.approvalId", "operation.id"], defaults: ["operation.state"] }),
  clockify_approvals_resubmit: single("resubmit-approval", { derivedIds: ["operation.approvalId", "operation.id"], defaults: ["operation.period"] }),
  clockify_webhooks_create: single("create-webhook"),
  clockify_webhooks_update: single("update-webhook", { derivedIds: ["operation.webhookId", "operation.id"] }),
  clockify_webhooks_delete: single("delete-webhook", { derivedIds: ["operation.webhookId", "operation.id"] }),
  clockify_users_invite: single("invite-user", { defaults: ["operation.sendEmail"] }),
  clockify_users_role_update: single("update-user-role", { derivedIds: ["operation.groupId", "operation.projectId", "operation.userId", "operation.granteeId", "operation.entityId"] }),
  clockify_users_rate_update: single("update-user-rate", { derivedIds: ["operation.userId"], defaults: ["operation.amountUnit"] }),
  clockify_users_hourly_rate_update: single("update-user-hourly-rate", { derivedIds: ["operation.userId"], authenticatedSelfLiterals: ["userId"] }),
  clockify_users_cost_rate_update: single("update-user-cost-rate", { derivedIds: ["operation.userId"], authenticatedSelfLiterals: ["userId"] }),
  clockify_users_deactivate: single("deactivate-user", { derivedIds: ["operation.userId"] }),
  clockify_groups_create: single("create-group"),
  clockify_groups_update: single("update-group", { derivedIds: ["operation.groupId", "operation.id"] }),
  clockify_groups_delete: single("delete-group", { derivedIds: ["operation.groupId", "operation.id"] }),
  clockify_groups_add_user: repeated(GROUP_MEMBER_BATCH_MAX, "members[]", [plan("single", step("add-user-to-group-*")), plan("batch", step("add-user-to-group-*", "primary", 2, GROUP_MEMBER_BATCH_MAX))], { derivedIds: ["operation.groupId", "operation.userIds[]"] }),
  clockify_groups_remove_user: single("remove-user-from-group", { derivedIds: ["operation.groupId", "operation.userId"] }),
  clockify_delete_entity: fixed(3, [
    ...["project", "client"].flatMap((entity) => [
      plan("single", step(`delete-${entity}`)),
      plan("curated", step(`archive-${entity}`), step(`delete-${entity}`), step(`restore-${entity}`, "compensation")),
    ]),
    ...["tag", "time_entry", "invoice", "expense", "webhook", "group"].map((entity) => plan("single", step(`delete-${entity}`))),
  ], { derivedIds: ["operation.id", "operation.projectId"] }),
  clockify_update_entity: fixed(1, [
    plan("single", step("update-project")), plan("single", step("update-client")), plan("single", step("update-tag")),
  ], { derivedIds: ["operation.id", "operation.body.clientId"] }),
  clockify_onboard_user: repeated(ONBOARD_USER_MUTATION_STEP_MAX, "groups[]", [
    plan("single", step("invite-user")),
    plan("curated", step("invite-user"), step("add-user-to-group-*", "primary", 1, ONBOARD_GROUP_BATCH_MAX)),
  ], { derivedIds: ["operation.groups[].id", "operation.groupIds[]", "operation.userId"], defaults: ["operation.sendEmail"] }, ONBOARD_GROUP_BATCH_MAX),
  clockify_setup_project: repeated(SETUP_PROJECT_MUTATION_STEP_MAX, "memberRates[]", [
    plan("single", step("create-project")),
    plan("curated", step("create-project"), step("add-project-members", "primary", 0, 1), step("set-project-rate-*", "primary", 0, SETUP_PROJECT_RATE_BATCH_MAX)),
  ], { derivedIds: ["operation.clientId", "operation.userIds[]", "operation.addUserIds[]", "operation.memberRates[].userId"], defaults: ["operation.projectRateKind", "operation.memberRates[].kind", "operation.rateUnit"] }, SETUP_PROJECT_RATE_BATCH_MAX),
  clockify_setup_task: repeated(2, "assignees[]", [plan("single", step("create-task")), plan("curated", step("create-task"), step("set-task-rate"))], { derivedIds: ["operation.projectId", "operation.assigneeIds[]"], defaults: ["operation.rate.kind", "operation.rateUnit"] }, SETUP_TASK_ASSIGNEE_BATCH_MAX),
} satisfies Readonly<Record<string, ActionAuthoritySemantics>>);

type LiteralObligation = AuthoredIntentMetadata["literalObligations"][number];

const obligation = (
  anyOfPaths: readonly string[],
  ...cuePatterns: string[]
): LiteralObligation => ({ anyOfPaths, cuePatterns });

const boundObligation = (
  anyOfPaths: readonly string[],
  sourceRolePatterns: readonly string[],
  cuePatterns: readonly string[] = sourceRolePatterns,
): LiteralObligation => ({ anyOfPaths, cuePatterns, sourceRolePatterns });

const ROLE_TOKEN = "(?<value>(?:[\"'][^\"'\\n]{1,80}[\"']|[\\p{L}\\p{N}][\\p{L}\\p{M}\\p{N}_.’'-]{0,79}))";
const ROLE_PHRASE = "(?<value>(?:[\"'][^\"'\\n]{1,120}[\"']|[\\p{L}\\p{N}][\\p{L}\\p{M}\\p{N}_.’' -]{0,119}?))";
const ROLE_LIST = "(?<value>(?:\\[[^\\]\\n]{0,480}\\]|[\"'][^\"'\\n]{1,160}[\"']|[\\p{L}\\p{N}][\\p{L}\\p{M}\\p{N}_.@+’'\\s,-]{0,159}))";

const authoredIntent = (
  commandPatterns: readonly string[],
  literalObligations: readonly LiteralObligation[] = [],
  forbiddenPatterns: readonly string[] = [],
  safeOmissionPaths: readonly string[] = [],
  commandGerundPatterns: readonly string[] = [],
): AuthoredIntentMetadata => ({
  commandPatterns,
  commandGerundPatterns,
  forbiddenPatterns,
  literalObligations,
  safeOmissionPaths,
});

/** The exact safe-write set has action-specific positive command grounding and
 * optional-literal presence decisions. These regex source strings are trusted,
 * catalog-fingerprinted data; the declaration pass never accepts provider-made
 * patterns. Semantic literal aliases are presence obligations automatically and
 * therefore are intentionally not duplicated below. */
const SAFE_WRITE_AUTHORED_INTENT = Object.freeze({
  clockify_start_timer: authoredIntent([
    "\\b(?:start|begin)(?:\\s+at)?(?:\\s+(?:a|the|my|new))?\\s+(?:(?:non[- ]?|not\\s+)?billable\\s+)?(?:work\\s+)?timer\\b",
    "\\bclock\\s+(?:me\\s+)?in\\b",
  ], [
    boundObligation(
      ["description"],
      [
        `\\b(?:description|note)(?:\\s+is|\\s*:)?\\s+${ROLE_PHRASE}(?=\\s+(?:on|for|with|tagged)\\b|[,.;!?]|$)`,
        `\\btimer\\s+(?:called|named)\\s+${ROLE_PHRASE}(?=\\s+(?:on|for|with|tagged)\\b|[,.;!?]|$)`,
      ],
      ["\\b(?:timer\\s+)?(?:description|note)\\b", "\\btimer\\s+(?:called|named)\\b"],
    ),
    boundObligation(
      ["projectId", "projectName"],
      [
        `\\bproject(?:\\s+(?:named|called))?\\s+${ROLE_PHRASE}(?=\\s+(?:with|and|for\\s+task|tagged)\\b|[,.;!?]|$)`,
        `\\b(?:on|for)\\s+(?!(?:task|today|yesterday|tomorrow)\\b)(?:project\\s+)?${ROLE_PHRASE}(?=\\s+(?:with|and|for\\s+task|tagged)\\b|[,.;!?]|$)`,
      ],
      [
        "\\bproject\\b",
        "\\b(?:on|for)\\s+(?!(?:task|today|yesterday|tomorrow)\\b)(?:project\\s+)?[\"'\\p{L}\\p{N}]",
      ],
    ),
    boundObligation(
      ["taskId", "taskName"],
      [`\\btask(?:\\s+(?:named|called))?\\s+${ROLE_PHRASE}(?=\\s+(?:with|and|tagged)\\b|[,.;!?]|$)`],
      ["\\btask\\b"],
    ),
    boundObligation(
      ["tagIds[]", "tagNames[]"],
      [
        `\\btagged\\s+${ROLE_LIST}(?=[,.;!?]|$)`,
        `\\btags?(?:\\s+(?:named|called|are|is|:))?\\s+${ROLE_LIST}(?=[,.;!?]|$)`,
      ],
      ["\\b(?:tags?|tagged)\\b"],
    ),
  ], ["\\b(?:create|make|add|set\\s+up)\\b[^.!?;\\n]{0,160}\\b(?:project|client|task|tag)\\b"], [], [
    "\\b(?:starting|beginning)(?:\\s+at)?(?:\\s+(?:a|the|my|new))?\\s+(?:(?:non[- ]?|not\\s+)?billable\\s+)?(?:work\\s+)?timer\\b",
    "\\bclocking\\s+(?:me\\s+)?in\\b",
  ]),

  clockify_stop_timer: authoredIntent([
    "\\b(?:stop|end)(?:\\s+(?:the|my|a|running))?\\s+(?:work\\s+)?timer\\b",
    "\\bclock\\s+(?:me\\s+)?out\\b",
  ], [], [], [], ["\\b(?:stopping|ending)(?:\\s+(?:the|my|a|running))?\\s+(?:work\\s+)?timer\\b", "\\bclocking\\s+(?:me\\s+)?out\\b"]),

  clockify_log_work: authoredIntent([
    "\\b(?:log|record|add|enter|track)\\b[^.!?;\\n]{0,48}\\b(?:time|hours?|work|(?:time\\s+)?entr(?:y|ies))\\b",
  ], [
    obligation(["description"], "\\b(?:description|note)\\b"),
    obligation(["start"], "\\b(?:from|starting(?:\\s+at)?|at)\\s+(?:\\d{1,2}(?::\\d{2})?|\\d{4}-\\d{2}-\\d{2}T)"),
    obligation(["end"], "\\b(?:to|until|ending(?:\\s+at)?)\\s+(?:\\d{1,2}(?::\\d{2})?|\\d{4}-\\d{2}-\\d{2}T)"),
    obligation(["date"], "\\b(?:today|yesterday|tomorrow|(?:(?:last|next|this)\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:on\\s+)?\\d{4}-\\d{2}-\\d{2})\\b"),
    obligation(["dayOffset"], "\\bday\\s+offset\\b"),
    obligation(["durationMinutes"], "\\b\\d+(?:\\.\\d+)?\\s*(?:m|min|mins|minute|minutes)\\b"),
    obligation(["durationHours"], "\\b\\d+(?:\\.\\d+)?\\s*(?:h|hr|hrs|hour|hours)\\b"),
    obligation(
      ["projectId", "projectName"],
      "\\bproject\\b",
      "\\b(?:on|to)\\s+(?!(?:today|yesterday|tomorrow|(?:(?:last|next|this)\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\\d{1,4}(?::\\d{2})?\\s*(?:am|pm)?|\\d{4}-\\d{2}-\\d{2})\\b)(?:project\\s+)?[\"'\\p{L}]",
    ),
    obligation(["taskId", "taskName"], "\\btask\\b"),
    obligation(["tagIds[]", "tagNames[]"], "\\b(?:tags?|tagged)\\b"),
  ], [], [], ["\\b(?:logging|recording|adding|entering|tracking)\\b[^.!?;\\n]{0,48}\\b(?:time|hours?|work|(?:time\\s+)?entr(?:y|ies))\\b"]),

  clockify_entries_create: authoredIntent([
    "\\b(?:log|record|add|enter|track)\\b[^.!?;\\n]{0,48}\\b(?:time|hours?|work|(?:time\\s+)?entr(?:y|ies))\\b",
  ], [
    obligation(["description"], "\\b(?:description|note)\\b"),
    obligation(["start"], "\\b(?:from|starting(?:\\s+at)?|at)\\s+(?:\\d{1,2}(?::\\d{2})?|\\d{4}-\\d{2}-\\d{2}T)"),
    obligation(["end"], "\\b(?:to|until|ending(?:\\s+at)?)\\s+(?:\\d{1,2}(?::\\d{2})?|\\d{4}-\\d{2}-\\d{2}T)"),
    obligation(["date"], "\\b(?:today|yesterday|tomorrow|(?:(?:last|next|this)\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:on\\s+)?\\d{4}-\\d{2}-\\d{2})\\b"),
    obligation(["dayOffset"], "\\bday\\s+offset\\b"),
    obligation(["durationMinutes"], "\\b\\d+(?:\\.\\d+)?\\s*(?:m|min|mins|minute|minutes)\\b"),
    obligation(["durationHours"], "\\b\\d+(?:\\.\\d+)?\\s*(?:h|hr|hrs|hour|hours)\\b"),
    obligation(
      ["projectId", "projectName"],
      "\\bproject\\b",
      "\\b(?:on|to)\\s+(?!(?:today|yesterday|tomorrow|(?:(?:last|next|this)\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\\d{1,4}(?::\\d{2})?\\s*(?:am|pm)?|\\d{4}-\\d{2}-\\d{2})\\b)(?:project\\s+)?[\"'\\p{L}]",
    ),
    obligation(["taskId", "taskName"], "\\btask\\b"),
    obligation(["tagIds[]"], "\\b(?:tags?|tagged)\\b"),
  ], [], [], ["\\b(?:logging|recording|adding|entering|tracking)\\b[^.!?;\\n]{0,48}\\b(?:time|hours?|work|(?:time\\s+)?entr(?:y|ies))\\b"]),

  clockify_entries_start: authoredIntent([
    "\\b(?:start|begin)(?:\\s+at)?(?:\\s+(?:a|the|my|new))?\\s+(?:(?:non[- ]?|not\\s+)?billable\\s+)?(?:work\\s+)?timer\\b",
    "\\bclock\\s+(?:me\\s+)?in\\b",
  ], [
    boundObligation(
      ["description"],
      [
        `\\b(?:description|note)(?:\\s+is|\\s*:)?\\s+${ROLE_PHRASE}(?=\\s+(?:on|for|with|tagged)\\b|[,.;!?]|$)`,
        `\\btimer\\s+(?:called|named)\\s+${ROLE_PHRASE}(?=\\s+(?:on|for|with|tagged)\\b|[,.;!?]|$)`,
      ],
      ["\\b(?:timer\\s+)?(?:description|note)\\b", "\\btimer\\s+(?:called|named)\\b"],
    ),
    boundObligation(
      ["projectId", "projectName"],
      [
        `\\bproject(?:\\s+(?:named|called))?\\s+${ROLE_PHRASE}(?=\\s+(?:with|and|for\\s+task|tagged)\\b|[,.;!?]|$)`,
        `\\b(?:on|for)\\s+(?!(?:task|today|yesterday|tomorrow)\\b)(?:project\\s+)?${ROLE_PHRASE}(?=\\s+(?:with|and|for\\s+task|tagged)\\b|[,.;!?]|$)`,
      ],
      [
        "\\bproject\\b",
        "\\b(?:on|for)\\s+(?!(?:task|today|yesterday|tomorrow)\\b)(?:project\\s+)?[\"'\\p{L}\\p{N}]",
      ],
    ),
    boundObligation(
      ["taskId", "taskName"],
      [`\\btask(?:\\s+(?:named|called))?\\s+${ROLE_PHRASE}(?=\\s+(?:with|and|tagged)\\b|[,.;!?]|$)`],
      ["\\btask\\b"],
    ),
    boundObligation(
      ["tagIds[]"],
      [
        `\\btagged\\s+${ROLE_LIST}(?=[,.;!?]|$)`,
        `\\btags?(?:\\s+(?:named|called|are|is|:))?\\s+${ROLE_LIST}(?=[,.;!?]|$)`,
      ],
      ["\\b(?:tags?|tagged)\\b"],
    ),
  ], ["\\b(?:create|make|add|set\\s+up)\\b[^.!?;\\n]{0,160}\\b(?:project|client|task|tag)\\b"], [], [
    "\\b(?:starting|beginning)(?:\\s+at)?(?:\\s+(?:a|the|my|new))?\\s+(?:(?:non[- ]?|not\\s+)?billable\\s+)?(?:work\\s+)?timer\\b",
    "\\bclocking\\s+(?:me\\s+)?in\\b",
  ]),

  clockify_create_work_package: authoredIntent([
    "\\b(?:create|make|add|set\\s+up)(?:\\s+(?:a|the|new))?\\s+work\\s+package\\b",
    "\\b(?:create|make|add|set\\s+up)\\b[^.!?;\\n]{0,180}\\b(?:project|client|task|tag)\\b[^.!?;\\n]{0,180}\\b(?:and|with|then)\\b[^.!?;\\n]{0,180}\\b(?:project|client|task|tag|start(?:\\s+a)?\\s+timer)\\b",
  ], [
    obligation(["tag.name", "tagName"], "\\btag\\b"),
    obligation(["client.name"], "\\b(?:create|make|add)(?:\\s+(?:a|the|new))?\\s+client\\b"),
    obligation(["project.clientName"], "\\bproject\\b[^.!?;\\n]{0,100}\\b(?:for|under)\\s+(?:client\\s+)?[\"'\\p{L}\\p{N}]"),
    obligation(["project.name", "projectName"], "\\bproject\\b"),
    obligation(["task.name", "taskName"], "\\btask\\b"),
    obligation(["startTimer.description"], "\\b(?:timer\\s+)?(?:description|note)\\b"),
  ], [], [], ["\\b(?:creating|making|adding|setting\\s+up)\\b[^.!?;\\n]{0,180}\\b(?:work\\s+package|(?:project|client|task|tag)\\b[^.!?;\\n]{0,180}\\b(?:and|with|then)\\b[^.!?;\\n]{0,180}\\b(?:project|client|task|tag|starting(?:\\s+a)?\\s+timer))\\b"]),

  clockify_projects_create: authoredIntent([
    "\\b(?:create(?:\\s+(?:a\\s+new|a|the|new|one))?|(?:make|add)\\s+(?:a\\s+new|a|new|one))\\s+(?:public\\s+|private\\s+|non[- ]public\\s+|not\\s+public\\s+|not\\s+private\\s+)?project\\b",
    "\\bnapravi(?:te)?\\b[^.!?;\\n]{0,80}\\bprojekat\\b",
  ], [
    boundObligation(["name"], [
      `\\bproject(?:\\s+(?:named|called))?\\s+${ROLE_PHRASE}(?=\\s+(?:for|under|with|and|from|using|based\\s+on)\\b|[,.;!?]|$)`,
      `\\bprojekat(?:\\s+(?:nazvan|imenovan))?\\s+${ROLE_PHRASE}(?=\\s+(?:za|sa|iz)\\b|[,.;!?]|$)`,
    ]),
    obligation(["clientId", "clientName"], "\\bclient\\b", "\\b(?:for|under)\\s+(?:client\\s+)?[\"'\\p{L}\\p{N}]"),
    obligation(["color"], "\\bcolou?r\\b|#[0-9a-f]{3,8}\\b"),
    obligation(["hourlyRate"], "\\b(?:hourly|billable)\\s+rate\\b"),
    obligation(["costRate"], "\\bcost\\s+rate\\b"),
    obligation(["rateUnit"], "\\b(?:major|minor)\\s+(?:currency\\s+)?units?\\b"),
  ], [
    "\\btemplate\\b",
    "\\bwork\\s+package\\b",
    "\\b(?:and|with|then)\\b[^.!?;\\n]{0,120}\\b(?:task|tag|start(?:\\s+a)?\\s+timer)\\b",
  ], [], ["\\b(?:creating|making|adding)(?:\\s+(?:a\\s+new|a|the|new|one))?\\s+(?:public\\s+|private\\s+)?project\\b"]),

  clockify_projects_from_template: authoredIntent([
    "\\b(?:create|make)(?:\\s+(?:a|the|new))?\\s+project\\b[^.!?;\\n]{0,160}\\b(?:from|using|based\\s+on)\\b[^.!?;\\n]{0,80}\\btemplate\\b",
  ], [
    boundObligation(["name"], [
      `\\bproject(?:\\s+(?:named|called))?\\s+${ROLE_PHRASE}(?=\\s+(?:from|using|based\\s+on)\\b)`,
    ]),
    boundObligation(["templateId", "templateName"], [
      `\\btemplate(?:\\s+(?:named|called))?\\s+${ROLE_PHRASE}(?=[,.;!?]|$)`,
    ], ["\\btemplate\\b"]),
  ], [], [], ["\\b(?:creating|making)(?:\\s+(?:a|the|new))?\\s+project\\b[^.!?;\\n]{0,160}\\b(?:from|using|based\\s+on)\\b[^.!?;\\n]{0,80}\\btemplate\\b"]),

  clockify_tasks_create: authoredIntent([
    "\\b(?:create|make|add)(?:\\s+(?:a|the|new|one))?\\s+task\\b",
  ], [
    boundObligation(["name"], [
      `\\btask(?:\\s+(?:named|called))?\\s+${ROLE_PHRASE}(?=\\s+(?:in|under|for|assigned|with)\\b|[,.;!?]|$)`,
    ]),
    boundObligation(["projectId"], [
      `\\bproject(?:\\s+(?:named|called))?\\s+${ROLE_PHRASE}(?=\\s+(?:for|assigned|with)\\b|[,.;!?]|$)`,
    ], ["\\bproject\\b"]),
    boundObligation(["assigneeIds[]"], [
      `\\b(?:assigned\\s+to|assign(?:ee|ees)?(?:\\s*:)?|for)\\s+${ROLE_LIST}(?=[,.;!?]|$)`,
    ], ["\\b(?:assign(?:ed|ment)?|assignee)\\b", "\\bfor\\s+(?!(?:project|task)\\b)[\"'\\p{L}]"]),
  ], [
    "\\b(?:and|with|then)\\b[^.!?;\\n]{0,120}\\b(?:project|client|tag|start(?:\\s+a)?\\s+timer)\\b",
    "\\b(?:hourly|billable|cost)\\s+rate\\b",
  ], [], ["\\b(?:creating|making|adding)(?:\\s+(?:a|the|new|one))?\\s+task\\b"]),

  clockify_clients_create: authoredIntent([
    "\\b(?:create|make|add)(?:\\s+(?:a|the|new|one))?\\s+(?:client|customer)\\b",
  ], [
    boundObligation(["name"], [
      `\\b(?:client|customer)(?:\\s+(?:named|called))?\\s+${ROLE_PHRASE}(?=\\s+(?:with|for|using)\\b|[,.;!?]|$)`,
    ]),
    boundObligation(["ccEmails[]"], [
      `\\b(?:cc|billing)\\s*(?:e-?mails?|recipients?)(?:\\s*:|\\s+are|\\s+is)?\\s+${ROLE_LIST}(?=[,.;!?]|$)`,
      "(?<value>[\\w.+-]+@[\\w.-]+\\.[a-z]{2,})",
    ], ["\\b(?:cc|billing)\\s*(?:e-?mails?|recipients?)\\b|[\\w.+-]+@[\\w.-]+\\.[a-z]{2,}\\b"]),
    boundObligation(["currency"], [
      `\\bcurrency(?:\\s*:|\\s+is)?\\s+${ROLE_TOKEN}(?=[,.;!?]|$)`,
      "(?<value>\\b(?:USD|EUR|GBP|CAD|AUD|JPY|CHF)\\b)",
    ], ["\\bcurrency\\b|\\b(?:USD|EUR|GBP|CAD|AUD|JPY|CHF)\\b"]),
  ], ["\\b(?:and|with|then)\\b[^.!?;\\n]{0,120}\\b(?:project|task|tag|start(?:\\s+a)?\\s+timer)\\b"], [], ["\\b(?:creating|making|adding)(?:\\s+(?:a|the|new|one))?\\s+(?:client|customer)\\b"]),

  clockify_clients_create_base: authoredIntent([
    "\\b(?:create|make|add)(?:\\s+(?:a|the|new|one))?\\s+(?:client|customer)\\b",
  ], [
    boundObligation(["name"], [
      `\\b(?:client|customer)(?:\\s+(?:named|called))?\\s+${ROLE_PHRASE}(?=\\s+(?:with|for|using)\\b|[,.;!?]|$)`,
    ]),
  ], [
    "\\b(?:cc|billing)\\s*(?:e-?mails?|recipients?)\\b|[\\w.+-]+@[\\w.-]+\\.[a-z]{2,}\\b",
    "\\bcurrency\\b|\\b(?:USD|EUR|GBP|CAD|AUD|JPY|CHF)\\b",
    "\\b(?:and|with|then)\\b[^.!?;\\n]{0,120}\\b(?:project|task|tag|start(?:\\s+a)?\\s+timer)\\b",
  ], [], ["\\b(?:creating|making|adding)(?:\\s+(?:a|the|new|one))?\\s+(?:client|customer)\\b"]),

  clockify_tags_create: authoredIntent([
    "\\b(?:(?:create|make)(?:\\s+(?:a\\s+new|a|the|new|one))?|add\\s+(?:a\\s+new|a|the|new|one))\\s+(?:tag|label)\\b",
  ], [
    boundObligation(["name"], [
      `\\b(?:tag|label)(?:\\s+(?:named|called))?\\s+${ROLE_PHRASE}(?=\\s+(?:for|to|with)\\b|[,.;!?]|$)`,
    ]),
  ], [
    "\\b(?:and|with|then)\\b[^.!?;\\n]{0,120}\\b(?:project|client|task|start(?:\\s+a)?\\s+timer)\\b",
    "\\bto\\s+(?:this|the|an?)\\s+(?:entry|project|task|timer)\\b",
  ], [], ["\\b(?:creating|making|adding)(?:\\s+(?:a\\s+new|a|the|new|one))?\\s+(?:tag|label)\\b"]),

  clockify_holidays_create: authoredIntent([
    "\\b(?:create|make|add)(?:\\s+(?:a|the|new|one|workspace))?\\s+holiday\\b",
  ], [
    obligation(["endDate"], "\\b(?:through|until|ending|ends|to)\\b"),
    obligation(["userIds[]"], "\\b(?:user|member|admin|me)\\b", "\\bfor\\s+(?!(?:(?:a|the)\\s+)?(?:team|group)\\b)[\"'\\p{L}]"),
    obligation(["userGroupIds[]"], "\\b(?:user\\s+)?group\\b|\\bteam\\b"),
  ], [], [], ["\\b(?:creating|making|adding)(?:\\s+(?:a|the|new|one|workspace))?\\s+holiday\\b"]),

  clockify_scheduling_assignments_create: authoredIntent([
    "\\b(?:create|make|add)(?:\\s+(?:a|the|new))?\\s+(?:scheduling\\s+)?(?:assignment|shift)\\b",
    "\\b(?:schedule|assign)\\b[^.!?;\\n]{0,100}\\b(?:admin|user|member|me|[\\p{L}][\\p{L}.'’-]+)\\b[^.!?;\\n]{0,160}\\b(?:project|shift|schedule|assignment|for|from|on)\\b",
  ], [
    obligation(["note"], "\\bnote\\b"),
  ], [], [], [
    "\\b(?:creating|making|adding)(?:\\s+(?:a|the|new))?\\s+(?:scheduling\\s+)?(?:assignment|shift)\\b",
    "\\b(?:scheduling|assigning)\\b[^.!?;\\n]{0,100}\\b(?:admin|user|member|me|[\\p{L}][\\p{L}.'’-]+)\\b[^.!?;\\n]{0,160}\\b(?:project|shift|schedule|assignment|for|from|on)\\b",
  ]),
} satisfies Readonly<Record<string, AuthoredIntentMetadata>>);

function collectPaths(node: JsonSchemaNode, prefix = ""): string[] {
  const branches = node.anyOf ?? node.oneOf;
  if (branches) return [...new Set(branches.flatMap((branch) => collectPaths(branch, prefix)))];
  if (node.type === "array" || node.items) {
    const arrayPath = `${prefix}[]`;
    const nested = node.items ? collectPaths(node.items, arrayPath) : [];
    return nested.length > 0 ? nested : [arrayPath];
  }
  const properties = node.properties;
  if (properties) {
    return Object.entries(properties).flatMap(([key, child]) =>
      collectPaths(child, prefix ? `${prefix}.${key}` : key));
  }
  return prefix ? [prefix] : [];
}

/** Optionality is inherited through an optional parent object/union. This is
 * derived from public JSON Schema output, never Zod's private `_def` shape. */
function collectOptionalLeafPaths(
  node: JsonSchemaNode,
  prefix = "",
  inheritedOptional = false,
): string[] {
  const branches = node.anyOf ?? node.oneOf;
  if (branches) {
    const branchLeaves = branches.map((branch) => new Set(collectPaths(branch, prefix)));
    const unionLeaves = new Set(branchLeaves.flatMap((paths) => [...paths]));
    const absentFromAnyBranch = [...unionLeaves].filter((path) =>
      branchLeaves.some((paths) => !paths.has(path)));
    return [...new Set([
      ...branches.flatMap((branch) => collectOptionalLeafPaths(branch, prefix, inheritedOptional)),
      ...absentFromAnyBranch,
    ])];
  }
  if (node.type === "array" || node.items) {
    const arrayPath = `${prefix}[]`;
    const nested = node.items
      ? collectOptionalLeafPaths(node.items, arrayPath, inheritedOptional)
      : [];
    return nested.length > 0 ? nested : inheritedOptional && prefix ? [arrayPath] : [];
  }
  const properties = node.properties;
  if (properties) {
    const required = new Set(node.required ?? []);
    return Object.entries(properties).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return collectOptionalLeafPaths(child, path, inheritedOptional || !required.has(key));
    });
  }
  return inheritedOptional && prefix ? [prefix] : [];
}

/** Public-schema adapter used by the authority builder and topology tests. It
 * deliberately accepts JSON Schema data instead of inspecting Zod internals. */
export function optionalLiteralPathsFromJsonSchema(schema: unknown): readonly string[] {
  if (!schema || typeof schema !== "object") return Object.freeze([]);
  return Object.freeze([...new Set(collectOptionalLeafPaths(schema as JsonSchemaNode))].sort());
}

const AUTHORED_PATTERN_MAX_BYTES = 1_024;

function validateAuthoredPattern(actionName: string, pattern: string): string {
  if (!pattern || Buffer.byteLength(pattern, "utf8") > AUTHORED_PATTERN_MAX_BYTES ||
    hasControlCharacter(pattern)) {
    throw new Error(`invalid_authored_intent_pattern:${actionName}`);
  }
  try {
    void new RegExp(pattern, "iu");
  } catch {
    throw new Error(`invalid_authored_intent_pattern:${actionName}`);
  }
  return pattern;
}

function authoredIntentFor(
  action: ActionDefinition,
  schema: JsonSchemaNode,
  literalControlledPaths: readonly string[],
  semanticLiteralAliases: readonly SemanticLiteralAlias[],
): AuthoredIntentMetadata | undefined {
  const source = SAFE_WRITE_AUTHORED_INTENT[
    action.name as keyof typeof SAFE_WRITE_AUTHORED_INTENT
  ];
  if (action.kind === "safe_write" && !source) {
    throw new Error(`missing_safe_write_authored_intent:${action.name}`);
  }
  if (action.kind !== "safe_write" && source) {
    throw new Error(`unexpected_safe_write_authored_intent:${action.name}`);
  }
  if (!source) return undefined;

  const commandPatterns = [...new Set(source.commandPatterns.map((pattern) =>
    validateAuthoredPattern(action.name, pattern)))].sort();
  if (commandPatterns.length === 0) {
    throw new Error(`missing_authored_intent_command:${action.name}`);
  }
  const forbiddenPatterns = [...new Set(source.forbiddenPatterns.map((pattern) =>
    validateAuthoredPattern(action.name, pattern)))].sort();
  const commandGerundPatterns = [...new Set(source.commandGerundPatterns.map((pattern) =>
    validateAuthoredPattern(action.name, pattern)))].sort();
  const controlled = new Set(literalControlledPaths);
  const optional = new Set([
    ...optionalLiteralPathsFromJsonSchema(schema),
    ...(action.argumentAliases ?? []),
  ]);
  const decisions = new Map<string, number>();
  const decide = (path: string, kind: string): void => {
    if (!controlled.has(path)) {
      throw new Error(`invalid_authored_intent_${kind}_path:${action.name}:${path}`);
    }
    if (optional.has(path)) decisions.set(path, (decisions.get(path) ?? 0) + 1);
  };

  const literalObligations = source.literalObligations.map((entry) => {
    const anyOfPaths = [...new Set(entry.anyOfPaths)].sort();
    const cuePatterns = [...new Set(entry.cuePatterns.map((pattern) =>
      validateAuthoredPattern(action.name, pattern)))].sort();
    const sourceRolePatterns = entry.sourceRolePatterns === undefined
      ? undefined
      : [...new Set(entry.sourceRolePatterns.map((pattern) => {
        const validated = validateAuthoredPattern(action.name, pattern);
        if (!validated.includes("(?<value>")) {
          throw new Error(`invalid_authored_intent_role_pattern:${action.name}`);
        }
        try {
          void new RegExp(validated, "diu");
        } catch {
          throw new Error(`invalid_authored_intent_role_pattern:${action.name}`);
        }
        return validated;
      }))].sort();
    if (anyOfPaths.length === 0 || cuePatterns.length === 0) {
      throw new Error(`invalid_authored_intent_obligation:${action.name}`);
    }
    for (const path of anyOfPaths) decide(path, "obligation");
    return Object.freeze({
      anyOfPaths: Object.freeze(anyOfPaths),
      cuePatterns: Object.freeze(cuePatterns),
      ...(sourceRolePatterns ? { sourceRolePatterns: Object.freeze(sourceRolePatterns) } : {}),
    });
  }).sort((left, right) => left.anyOfPaths.join("\0").localeCompare(right.anyOfPaths.join("\0")));

  // A reviewed semantic alias is also a presence cue: when its authored phrase
  // occurs outside another literal span, the declaration must bind this path.
  for (const path of new Set(semanticLiteralAliases.map((alias) => alias.path))) {
    decide(path, "semantic_alias");
  }
  const safeOmissionPaths = [...new Set(source.safeOmissionPaths)].sort();
  for (const path of safeOmissionPaths) decide(path, "safe_omission");

  const uncovered = [...optional].filter((path) => (decisions.get(path) ?? 0) === 0).sort();
  const multiplyCovered = [...decisions].filter(([, count]) => count !== 1).map(([path]) => path).sort();
  if (uncovered.length > 0 || multiplyCovered.length > 0) {
    throw new Error(
      `safe_write_authored_intent_coverage:${action.name}:uncovered=${uncovered.join(",")};multiple=${multiplyCovered.join(",")}`,
    );
  }

  return Object.freeze({
    commandPatterns: Object.freeze(commandPatterns),
    commandGerundPatterns: Object.freeze(commandGerundPatterns),
    forbiddenPatterns: Object.freeze(forbiddenPatterns),
    literalObligations: Object.freeze(literalObligations),
    safeOmissionPaths: Object.freeze(safeOmissionPaths),
  });
}

const SEMANTIC_LITERAL_ALIAS_MAX_BYTES = 256;

/** Apply the exact same Unicode normalization used for reviewed semantic
 * literal aliases. Deliberately does not trim, unquote, case-fold, or collapse
 * spacing: padded/quoted/rewritten text needs its own explicit reviewed alias. */
export function normalizeSemanticLiteralAliasPhrase(text: string): string {
  return text.normalize("NFC");
}

function schemaNodesAtPath(
  node: JsonSchemaNode,
  segments: readonly string[],
  index = 0,
): JsonSchemaNode[] {
  const branches = node.anyOf ?? node.oneOf;
  if (branches) return branches.flatMap((branch) => schemaNodesAtPath(branch, segments, index));
  if (index === segments.length) return [node];
  const segment = segments[index]!;
  const isArrayItem = segment.endsWith("[]");
  const propertyName = isArrayItem ? segment.slice(0, -2) : segment;
  if (!propertyName || !node.properties?.[propertyName]) return [];
  const child = node.properties[propertyName]!;
  if (isArrayItem) {
    const arrayBranches = child.anyOf ?? child.oneOf ?? [child];
    return arrayBranches.flatMap((branch) => branch.items
      ? schemaNodesAtPath(branch.items, segments, index + 1)
      : []);
  }
  return schemaNodesAtPath(child, segments, index + 1);
}

function schemaRequiresNumericScalar(node: JsonSchemaNode): boolean {
  const branches = node.anyOf ?? node.oneOf;
  if (branches) return branches.length > 0 && branches.every(schemaRequiresNumericScalar);
  if (node.const !== undefined) return typeof node.const === "number" && Number.isFinite(node.const);
  if (node.enum) {
    return node.enum.length > 0 && node.enum.every((value) =>
      typeof value === "number" && Number.isFinite(value));
  }
  const types = typeof node.type === "string" ? [node.type] : node.type;
  return types !== undefined && types.length > 0 &&
    types.every((type) => type === "number" || type === "integer");
}

/** Public-JSON-schema-derived numeric leaves. Ambiguous union paths and aliases
 * absent from the closed schema are intentionally excluded. */
function numericLiteralPathsFromJsonSchema(
  schema: JsonSchemaNode,
  literalControlledPaths: readonly string[],
): readonly string[] {
  return Object.freeze(literalControlledPaths.filter((path) => {
    if (path.includes(".*")) return false;
    const nodes = schemaNodesAtPath(schema, path.split("."));
    return nodes.length > 0 && nodes.every(schemaRequiresNumericScalar);
  }).sort());
}

function sameScalar(left: unknown, right: unknown): boolean {
  return typeof left === "number" && typeof right === "number"
    ? Object.is(left, right)
    : left === right;
}

function schemaAcceptsScalar(node: JsonSchemaNode, value: SemanticLiteralAlias["value"]): boolean {
  const branches = node.anyOf ?? node.oneOf;
  if (branches) return branches.some((branch) => schemaAcceptsScalar(branch, value));
  if (node.const !== undefined && !sameScalar(node.const, value)) return false;
  if (node.enum && !node.enum.some((candidate) => sameScalar(candidate, value))) return false;
  const types = typeof node.type === "string" ? [node.type] : node.type;
  if (!types || types.length === 0) return node.const !== undefined || node.enum !== undefined;
  if (value === null) return types.includes("null");
  if (typeof value === "string") return types.includes("string");
  if (typeof value === "boolean") return types.includes("boolean");
  if (!Number.isFinite(value)) return false;
  return types.includes("number") || (types.includes("integer") && Number.isInteger(value));
}

function scalarKey(value: SemanticLiteralAlias["value"]): string {
  return `${value === null ? "null" : typeof value}:${JSON.stringify(value)}`;
}

function hasControlCharacter(text: string): boolean {
  return [...text].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function semanticLiteralAliasesFor(
  action: ActionDefinition,
  schema: JsonSchemaNode,
  literalControlledPaths: readonly string[],
): readonly SemanticLiteralAlias[] {
  const aliases = action.semanticLiteralAliases ?? [];
  const controlled = new Set(literalControlledPaths);
  const seenValues = new Set<string>();
  const seenPhrases = new Map<string, string>();
  const validated: SemanticLiteralAlias[] = [];

  for (const alias of aliases) {
    if (!alias || typeof alias.path !== "string" || !controlled.has(alias.path) ||
      alias.path.endsWith(".*") || alias.path.includes(".*")) {
      throw new Error(`invalid_semantic_literal_alias_path:${action.name}:${alias?.path ?? ""}`);
    }
    if (typeof alias.value !== "boolean" && typeof alias.value !== "string") {
      throw new Error(`invalid_semantic_literal_alias_value:${action.name}:${alias.path}`);
    }
    const schemaNodes = schemaNodesAtPath(schema, alias.path.split("."));
    if (schemaNodes.length === 0 || !schemaNodes.some((node) => schemaAcceptsScalar(node, alias.value))) {
      throw new Error(`invalid_semantic_literal_alias_value:${action.name}:${alias.path}`);
    }
    if (!Array.isArray(alias.authoredPhrases) || alias.authoredPhrases.length === 0) {
      throw new Error(`invalid_semantic_literal_alias_phrase:${action.name}:${alias.path}`);
    }

    const valueKey = `${alias.path}\0${scalarKey(alias.value)}`;
    if (seenValues.has(valueKey)) {
      throw new Error(`duplicate_semantic_literal_alias_value:${action.name}:${alias.path}`);
    }
    seenValues.add(valueKey);
    const phrases: string[] = [];
    for (const phrase of alias.authoredPhrases) {
      const normalized = typeof phrase === "string" ? normalizeSemanticLiteralAliasPhrase(phrase) : "";
      if (!normalized || normalized !== phrase || phrase.trim() !== phrase || hasControlCharacter(normalized) ||
        Buffer.byteLength(normalized, "utf8") > SEMANTIC_LITERAL_ALIAS_MAX_BYTES) {
        throw new Error(`invalid_semantic_literal_alias_phrase:${action.name}:${alias.path}`);
      }
      const phraseKey = `${alias.path}\0${normalized}`;
      const priorValue = seenPhrases.get(phraseKey);
      if (priorValue !== undefined) {
        throw new Error(priorValue === scalarKey(alias.value)
          ? `duplicate_semantic_literal_alias:${action.name}:${alias.path}:${normalized}`
          : `ambiguous_semantic_literal_alias:${action.name}:${alias.path}:${normalized}`);
      }
      seenPhrases.set(phraseKey, scalarKey(alias.value));
      phrases.push(normalized);
    }
    validated.push(Object.freeze({
      path: alias.path,
      value: alias.value,
      authoredPhrases: Object.freeze([...phrases].sort()),
    }));
  }

  return Object.freeze(validated.sort((left, right) =>
    left.path.localeCompare(right.path) ||
    scalarKey(left.value).localeCompare(scalarKey(right.value)) ||
    left.authoredPhrases.join("\0").localeCompare(right.authoredPhrases.join("\0"))));
}

/** Build the explicit catalog declaration from the action's closed model-visible
 * schema plus named action semantics. Schema derivation is limited to raw
 * literal leaves; id/default/cardinality authority never comes from a field
 * name or from the accidental presence of an array. */
export function writeAuthorityFor(action: ActionDefinition): WriteAuthorityMetadata {
  const schema = zodToJsonSchema(action.schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as JsonSchemaNode;
  const schemaPaths = collectPaths(schema);
  // Closed schema leaves remain exact. Reviewed open-record paths use an
  // explicit `.*` suffix so the raw matcher can authorize descendants only
  // when the action deliberately accepts dynamic keys; a scalar leaf such as
  // `name` must never accidentally authorize `name.invented`.
  const openRecordPaths = (action.argumentOpenPaths ?? []).map((path) => `${path}.*`);
  const literalControlledPaths = [...new Set([
    ...schemaPaths,
    ...(action.argumentAliases ?? []),
    ...openRecordPaths,
  ])].sort();
  const semanticLiteralAliases = semanticLiteralAliasesFor(action, schema, literalControlledPaths);
  const numericLiteralPaths = numericLiteralPathsFromJsonSchema(schema, literalControlledPaths);
  const authoredIntent = authoredIntentFor(
    action,
    schema,
    literalControlledPaths,
    semanticLiteralAliases,
  );
  const semantics = ACTION_SEMANTICS[action.name as keyof typeof ACTION_SEMANTICS];
  if (!semantics) throw new Error(`missing_write_authority_semantics:${action.name}`);
  const authenticatedSelfLiteralPaths = [...new Set(semantics.authenticatedSelfLiterals ?? [])].sort();
  if (authenticatedSelfLiteralPaths.some((path) => !literalControlledPaths.includes(path))) {
    throw new Error(`invalid_authenticated_self_literal_path:${action.name}`);
  }
  const serverDerivedIdPaths = [...new Set([
    "operation.operationId",
    "operation.workspaceId",
    "operation.adminUserId",
    ...(semantics.derivedIds ?? []),
  ])].sort();
  const permittedServerDefaultPaths = [...new Set(semantics.defaults ?? [])].sort();
  const preservedStatePaths = [...new Set(semantics.preservedState ?? [])].sort();
  return Object.freeze({
    literalConstraintLimits: INTENT_LITERAL_LIMITS,
    literalControlledPaths: Object.freeze(literalControlledPaths),
    numericLiteralPaths,
    semanticLiteralAliases,
    authenticatedSelfLiteralPaths: Object.freeze(authenticatedSelfLiteralPaths),
    ...(authoredIntent ? { authoredIntent } : {}),
    serverDerivedIdPaths: Object.freeze(serverDerivedIdPaths),
    permittedServerDefaultPaths: Object.freeze(permittedServerDefaultPaths),
    preservedStatePaths: Object.freeze(preservedStatePaths),
    cardinality: Object.freeze(semantics.cardinality),
    mutationPlans: Object.freeze(semantics.mutationPlans.map((variant) => Object.freeze({
      mode: variant.mode,
      minSteps: variant.minSteps,
      maxSteps: variant.maxSteps,
      steps: Object.freeze(variant.steps.map((rule) => Object.freeze({ ...rule }))),
    }))),
  });
}

/** Exact reviewed key set used by catalog assembly and regression tests. */
export function writeAuthorityActionNames(): readonly string[] {
  return Object.freeze(Object.keys(ACTION_SEMANTICS));
}

function stepIdMatches(pattern: string, id: string, occurrence: number): boolean {
  return pattern.endsWith("*") ? id === `${pattern.slice(0, -1)}${occurrence}` : id === pattern;
}

function stepsMatch(
  actual: ExternalMutationPlan["steps"],
  rules: readonly StepRule[],
  actualIndex = 0,
  ruleIndex = 0,
): boolean {
  if (ruleIndex === rules.length) return actualIndex === actual.length;
  const rule = rules[ruleIndex]!;
  let matching = 0;
  while (matching < rule.max && actualIndex + matching < actual.length) {
    const candidate = actual[actualIndex + matching]!;
    if (candidate.kind !== rule.kind || !stepIdMatches(rule.id, candidate.id, matching)) break;
    matching += 1;
  }
  for (let count = matching; count >= rule.min; count -= 1) {
    if (stepsMatch(actual, rules, actualIndex + count, ruleIndex + 1)) return true;
  }
  return false;
}

function collectOperationLeaves(value: unknown, prefix = "operation"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectOperationLeaves(item, `${prefix}[]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      collectOperationLeaves(child, `${prefix}.${key}`));
  }
  return [prefix];
}

const EVIDENCE_SEGMENTS = new Set([
  "baselineIds", "beforeIds", "invoiceBaseline", "targetSnapshots", "rawItems",
  "itemSnapshot", "paymentSnapshot", "expectedAfterFields", "expectedAfterStatus", "expectedProjection",
  "restoreBody", "archiveBody", "originalBody",
]);
const DEFAULTABLE_LEAVES = new Set([
  "amountUnit", "applyTaxes", "archived", "currency", "description", "dueDate",
  "issuedDate", "kind", "number", "period", "rateUnit", "sendEmail",
  "start", "state", "unitPriceUnit",
]);

function leafName(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1).replace(/\[\]$/, "");
}

function evidencePath(path: string): boolean {
  return path.split(".").some((segment) => EVIDENCE_SEGMENTS.has(segment.replace(/\[\]$/, "")));
}

function metadataPathMatches(declared: readonly string[], path: string): boolean {
  return declared.some((candidate) => candidate === path ||
    (candidate.endsWith("*") && path.startsWith(candidate.slice(0, -1))));
}

/** Validate the normalized durable operation and exact persisted host plan
 * against the same reviewed authority metadata fingerprinted into the catalog. */
export function validateWriteAuthorityOperation(
  action: ActionDefinition,
  operation: unknown,
  mutationPlan: ExternalMutationPlan | undefined,
): string | undefined {
  const authority = action.writeAuthority;
  if (!authority) return "missing_write_authority";
  if (!mutationPlan || !Array.isArray(mutationPlan.steps) || mutationPlan.steps.length === 0) {
    return "missing_mutation_plan";
  }
  if (mutationPlan.steps.length > authority.cardinality.maxExecutions) {
    return "mutation_cardinality_exceeded";
  }
  if (!Number.isSafeInteger(mutationPlan.maxHostCalls) ||
    (mutationPlan.maxHostCalls as number) < 1 ||
    (mutationPlan.maxHostCalls as number) > TURN_HOST_CALL_LIMIT) {
    return "invalid_mutation_host_call_budget";
  }
  const declaredPlan = authority.mutationPlans.some((variant) =>
    variant.mode === mutationPlan.mode &&
    mutationPlan.steps.length >= variant.minSteps && mutationPlan.steps.length <= variant.maxSteps &&
    stepsMatch(mutationPlan.steps, variant.steps));
  if (!declaredPlan) return "undeclared_mutation_plan";

  const literalLeafNames = new Set(authority.literalControlledPaths.map(leafName));
  for (const path of collectOperationLeaves(operation)) {
    if (evidencePath(path)) continue;
    const leaf = leafName(path);
    if (/Ids?$/.test(leaf) && !["operationId", "workspaceId", "adminUserId"].includes(leaf) &&
      !metadataPathMatches(authority.serverDerivedIdPaths, path)) {
      return `undeclared_server_derived_path:${path}`;
    }
    if (DEFAULTABLE_LEAVES.has(leaf) && !literalLeafNames.has(leaf) &&
      !metadataPathMatches(authority.permittedServerDefaultPaths, path) &&
      !metadataPathMatches(authority.preservedStatePaths, path)) {
      return `undeclared_server_default_path:${path}`;
    }
  }
  return undefined;
}
