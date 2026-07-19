import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  ActionDefinition,
  ExternalMutationPlan,
  WriteAuthorityMetadata,
} from "./action.js";
import {
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
  properties?: Record<string, JsonSchemaNode>;
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

/**
 * Action semantics are deliberately named here. Schema arrays describe values,
 * not host-call count: tagIds, ccEmails, and assigneeIds can all travel in one
 * request, while curated workflows can dispatch multiple exact plan steps.
 */
const ACTION_SEMANTICS = Object.freeze({
  clockify_start_timer: single("start-timer", { derivedIds: ["operation.projectId", "operation.taskId", "operation.tagIds[]", "operation.body.projectId", "operation.body.taskId", "operation.body.tagIds[]", "operation.body.userId"], defaults: ["operation.body.start"] }),
  clockify_stop_timer: single("stop-timer", { derivedIds: ["operation.entryId", "operation.userId"] }),
  clockify_log_work: single("log-time-entry", { derivedIds: ["operation.projectId", "operation.taskId", "operation.tagIds[]", "operation.body.projectId", "operation.body.taskId", "operation.body.tagIds[]"] }),
  clockify_fix_entry: single("update-time-entry", { derivedIds: ["operation.entryId", "operation.projectId", "operation.taskId", "operation.tagIds", "operation.tagIds[]", "operation.body.projectId", "operation.body.taskId", "operation.body.tagIds[]"], defaults: ["operation.body.start"] }),
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
  clockify_projects_rate_update: single("update-project-rate", { derivedIds: ["operation.projectId", "operation.userId"] }),
  clockify_projects_estimate_update: single("update-project-estimate", { derivedIds: ["operation.projectId"] }),
  clockify_projects_memberships_update: single("update-project-memberships", { derivedIds: ["operation.projectId", "operation.userIds[]", "operation.memberships[].userId"] }),
  clockify_tasks_create: single("create-task", { derivedIds: ["operation.projectId", "operation.assigneeIds[]", "operation.body.projectId", "operation.body.assigneeIds[]"] }),
  clockify_tasks_update: single("update-task", { derivedIds: ["operation.projectId", "operation.taskId", "operation.id", "operation.assigneeIds[]", "operation.body.projectId", "operation.body.assigneeIds[]", "operation.patch.assigneeIds[]"] }),
  clockify_tasks_delete: fixed(3, [
    plan("single", step("delete-task")),
    plan("curated", step("complete-task-for-delete"), step("delete-task"), step("restore-task-status", "compensation")),
  ], { derivedIds: ["operation.projectId", "operation.taskId", "operation.id", "operation.doneBody.projectId"] }),
  clockify_tasks_rate_update: single("update-task-rate", { derivedIds: ["operation.projectId", "operation.taskId"] }),
  clockify_clients_create: fixed(2, [plan("single", step("create-client")), plan("curated", step("create-client"), step("enrich-client"))], { derivedIds: ["operation.enrichment.currencyId"] }),
  clockify_clients_update: single("update-client", { derivedIds: ["operation.clientId", "operation.id", "operation.body.currencyId", "operation.patch.currencyId"] }),
  clockify_clients_delete: fixed(3, [
    plan("single", step("delete-client")),
    plan("curated", step("archive-client"), step("delete-client"), step("restore-client", "compensation")),
  ], { derivedIds: ["operation.clientId", "operation.id"] }),
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
  clockify_approvals_reject: single("set-approval-state", { derivedIds: ["operation.approvalId", "operation.id"], defaults: ["operation.state"] }),
  clockify_approvals_withdraw: single("withdraw-approval", { derivedIds: ["operation.approvalId", "operation.id"], defaults: ["operation.state"] }),
  clockify_approvals_resubmit: single("resubmit-approval", { derivedIds: ["operation.approvalId", "operation.id"], defaults: ["operation.period"] }),
  clockify_webhooks_create: single("create-webhook"),
  clockify_webhooks_update: single("update-webhook", { derivedIds: ["operation.webhookId", "operation.id"] }),
  clockify_webhooks_delete: single("delete-webhook", { derivedIds: ["operation.webhookId", "operation.id"] }),
  clockify_users_invite: single("invite-user", { defaults: ["operation.sendEmail"] }),
  clockify_users_role_update: single("update-user-role", { derivedIds: ["operation.groupId", "operation.projectId", "operation.userId", "operation.granteeId", "operation.entityId"] }),
  clockify_users_rate_update: single("update-user-rate", { derivedIds: ["operation.userId"], defaults: ["operation.amountUnit"] }),
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
  const semantics = ACTION_SEMANTICS[action.name as keyof typeof ACTION_SEMANTICS];
  if (!semantics) throw new Error(`missing_write_authority_semantics:${action.name}`);
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
