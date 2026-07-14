import type { WorkspaceClient } from "../clockify/client.js";
import type { ListResult } from "../clockify/types.js";
import type { Installation, Store } from "../db/store.js";
import { actionFingerprint, catalogHash } from "./catalog.js";
import type { ReconciliationBinding, ReconciliationCandidate, ReconciliationResult } from "./reconciliation.js";
import { reconcileExternalMutation } from "./reconciliation.js";
import { sanitizedFingerprint } from "./safe-json.js";
import { runStoreStartupReconciliation, type StartupReconciliationCandidate } from "./startup-reconciliation.js";
import { APPROVAL_STARTUP_RECONCILIATION } from "./workflows/approvals.js";
import { SCHEDULING_STARTUP_RECONCILIATION } from "./workflows/scheduling.js";
import { WEBHOOK_STARTUP_RECONCILIATION } from "./workflows/webhooks.js";
import { USER_GROUP_STARTUP_RECONCILIATION } from "./workflows/users.js";
import {
  STRUCTURE_STARTUP_RECONCILIATION,
  hasStructureStartupReconciliationHandler,
  reconcileWithStructureStartupRegistry,
  type StructureStartupReconciliationReadClient,
} from "./workflows/structure-startup-reconciliation.js";
import {
  LEAVE_BILLING_STARTUP_RECONCILIATION,
  hasLeaveBillingStartupReconciliationHandler,
  reconcileWithLeaveBillingStartupRegistry,
  type LeaveBillingStartupReconciliationReadClient,
} from "./workflows/leave-billing-startup-reconciliation.js";

type StartupStep = StartupReconciliationCandidate["steps"][number];

/** The registry receives only the read methods it uses. No mutation function is
 * reachable from a handler, which makes startup compensation impossible by
 * construction. */
type ControlStartupReconciliationReadClient = Pick<WorkspaceClient,
  | "listApprovals" | "getApproval"
  | "listAssignments" | "getAssignment"
  | "listWebhooks" | "getWebhook"
  | "listUsers" | "listUserRoleAssignments" | "getWorkspaceMemberRate"
  | "listGroups" | "getGroup"
>;

export type StartupReconciliationReadClient =
  ControlStartupReconciliationReadClient &
  StructureStartupReconciliationReadClient &
  LeaveBillingStartupReconciliationReadClient;

interface HandlerInput {
  binding: ReconciliationBinding;
  candidate: StartupReconciliationCandidate;
  step: StartupStep;
  clockify: StartupReconciliationReadClient;
}

type Handler = (input: HandlerInput) => Promise<ReconciliationResult>;

function payloadOf(candidate: StartupReconciliationCandidate): Record<string, unknown> | undefined {
  if (!candidate.operation || typeof candidate.operation !== "object" || Array.isArray(candidate.operation)) return undefined;
  const operation = candidate.operation as Record<string, unknown>;
  const payload = operation.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload as Record<string, unknown>;
  return operation;
}

function invalidInput(input: HandlerInput): ReconciliationResult {
  return {
    authoritative: false,
    reason: "invalid_evidence",
    binding: input.binding,
    evidence: { complete: false },
  };
}

function approvalProjection(row: { state?: string; periodStart?: string }): unknown {
  return { state: row.state, periodStart: row.periodStart };
}

function singleReadHandler(input: HandlerInput, options: {
  strategy: "update" | "delete" | "state-command";
  read(): Promise<ListResult<ReconciliationCandidate>>;
  matches(candidate: ReconciliationCandidate): boolean;
}): Promise<ReconciliationResult> {
  return reconcileExternalMutation({
    strategy: options.strategy,
    binding: input.binding,
    expected: { actionFingerprint: input.candidate.actionFingerprint, catalogHash: input.candidate.catalogHash },
    readEvidence: () => options.read(),
    matches: (candidate) => options.matches(candidate),
  });
}

function assignmentProjection(row: {
  id: string; userId?: string; projectId?: string; start?: string; end?: string;
  hoursPerDay?: number; startTime?: string; note?: string; published?: boolean;
}): unknown {
  return {
    id: row.id, userId: row.userId, projectId: row.projectId, start: row.start, end: row.end,
    hoursPerDay: row.hoursPerDay, startTime: row.startTime, note: row.note, published: row.published,
  };
}

function createdAssignmentProjection(row: {
  userId?: string; projectId?: string; start?: string; end?: string; hoursPerDay?: number;
  startTime?: string; note?: string; published?: boolean;
}): unknown {
  return {
    userId: row.userId, projectId: row.projectId, start: row.start, end: row.end,
    hoursPerDay: row.hoursPerDay,
    ...(row.startTime !== undefined ? { startTime: row.startTime } : {}),
    ...(row.note !== undefined ? { note: row.note } : {}),
    published: row.published ?? false,
  };
}

function webhookCreateProjection(row: {
  url?: string; webhookEvent?: string; triggerSource?: string[]; triggerSourceType?: string;
}): unknown {
  return {
    url: row.url,
    webhookEvent: row.webhookEvent,
    triggerSource: [...(row.triggerSource ?? [])].sort(),
    triggerSourceType: row.triggerSourceType,
  };
}

const normalizedText = (value: string): string => value.normalize("NFKC").trim().toLocaleLowerCase("en-US");

function createFromList(options: {
  list(input: HandlerInput, payload: Record<string, unknown>): Promise<ListResult<{ id: string } & Record<string, unknown>>>;
  project(row: Record<string, unknown>): unknown;
  entity: string;
}): Handler {
  return async (input) => {
    const payload = payloadOf(input.candidate);
    const baselineIds = Array.isArray(payload?.baselineIds) && payload.baselineIds.every((id) => typeof id === "string")
      ? payload.baselineIds as string[]
      : undefined;
    const finalFingerprint = typeof payload?.finalFingerprint === "string" ? payload.finalFingerprint : undefined;
    if (!payload || !baselineIds || !finalFingerprint) return invalidInput(input);
    const baseline = new Set(baselineIds);
    return reconcileExternalMutation({
      strategy: "create",
      binding: input.binding,
      expected: { actionFingerprint: input.candidate.actionFingerprint, catalogHash: input.candidate.catalogHash },
      async readEvidence() {
        const listed = await options.list(input, payload);
        return {
          truncated: listed.truncated,
          rows: listed.rows.filter((row) => !baseline.has(row.id)).map((row) => ({
            ref: { type: options.entity, id: row.id }, projection: options.project(row),
          })),
        };
      },
      matches: (candidate) => sanitizedFingerprint(candidate.projection) === finalFingerprint,
    });
  };
}

const submitApproval: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const baselineIds = Array.isArray(payload?.baselineIds) && payload.baselineIds.every((id) => typeof id === "string")
    ? payload.baselineIds as string[]
    : undefined;
  const finalFingerprint = typeof payload?.finalFingerprint === "string" ? payload.finalFingerprint : undefined;
  if (!baselineIds || !finalFingerprint) return invalidInput(input);
  const baseline = new Set(baselineIds);
  return reconcileExternalMutation({
    strategy: "create",
    binding: input.binding,
    expected: { actionFingerprint: input.candidate.actionFingerprint, catalogHash: input.candidate.catalogHash },
    async readEvidence(): Promise<ListResult<ReconciliationCandidate>> {
      const listed = await input.clockify.listApprovals();
      return {
        truncated: listed.truncated,
        rows: listed.rows.filter((row) => !baseline.has(row.id)).map((row) => ({
          ref: { type: "approval", id: row.id },
          projection: approvalProjection(row),
        })),
      };
    },
    matches: (candidate) => sanitizedFingerprint(candidate.projection) === finalFingerprint,
  });
};

const createAssignment = createFromList({
  entity: "assignment",
  async list(input, payload) {
    const filter = payload.filter && typeof payload.filter === "object" ? payload.filter as Parameters<WorkspaceClient["listAssignments"]>[0] : undefined;
    return await input.clockify.listAssignments(filter) as unknown as ListResult<{ id: string } & Record<string, unknown>>;
  },
  project: (row) => createdAssignmentProjection(row),
});

const updateAssignment: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const id = typeof payload?.id === "string" ? payload.id : undefined;
  if (!id || payload?.expectedProjection === undefined) return invalidInput(input);
  const expected = sanitizedFingerprint(payload.expectedProjection);
  return singleReadHandler(input, {
    strategy: "update",
    async read() {
      const row = await input.clockify.getAssignment(id);
      return { truncated: false, rows: row ? [{ ref: { type: "assignment", id }, projection: assignmentProjection(row) }] : [] };
    },
    matches: (candidate) => sanitizedFingerprint(candidate.projection) === expected,
  });
};

const deleteAssignment: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const id = typeof payload?.id === "string" ? payload.id : undefined;
  if (!id) return invalidInput(input);
  return singleReadHandler(input, {
    strategy: "delete",
    async read() {
      const listed = await input.clockify.listAssignments();
      return { truncated: listed.truncated, rows: listed.rows.map((row) => ({ ref: { type: "assignment", id: row.id }, projection: {} })) };
    },
    matches: (candidate) => candidate.ref.id === id,
  });
};

const publishSchedule: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const start = typeof payload?.start === "string" ? payload.start : undefined;
  const end = typeof payload?.end === "string" ? payload.end : undefined;
  if (!start || !end || payload?.expectedProjection === undefined) return invalidInput(input);
  const userId = typeof payload.userId === "string" ? payload.userId : undefined;
  const notifyUsers = payload.notifyUsers === true;
  const expected = sanitizedFingerprint(payload.expectedProjection);
  return singleReadHandler(input, {
    strategy: "state-command",
    async read() {
      const listed = await input.clockify.listAssignments({ start, end, ...(userId ? { userId } : {}) });
      const projection = {
        start, end, notifyUsers, userId,
        assignments: [...listed.rows].sort((a, b) => a.id.localeCompare(b.id)).map(assignmentProjection),
      };
      return { truncated: listed.truncated, rows: [{ ref: { type: "schedule-range", id: "range" }, projection }] };
    },
    matches: (candidate) => sanitizedFingerprint(candidate.projection) === expected,
  });
};

const createWebhook = createFromList({
  entity: "webhook",
  async list(input) { return await input.clockify.listWebhooks() as unknown as ListResult<{ id: string } & Record<string, unknown>>; },
  project: (row) => webhookCreateProjection(row),
});

const updateWebhook: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const id = typeof payload?.id === "string" ? payload.id : undefined;
  const body = payload?.body && typeof payload.body === "object" && !Array.isArray(payload.body) ? payload.body as Record<string, unknown> : undefined;
  if (!id || !body) return invalidInput(input);
  const expected = sanitizedFingerprint({ ...body, triggerSource: Array.isArray(body.triggerSource) ? [...body.triggerSource].sort() : body.triggerSource });
  return singleReadHandler(input, {
    strategy: "update",
    async read() {
      const row = await input.clockify.getWebhook(id);
      return { truncated: false, rows: row ? [{ ref: { type: "webhook", id }, projection: {
        name: row.name, url: row.url, webhookEvent: row.webhookEvent,
        triggerSource: [...(row.triggerSource ?? [])].sort(), triggerSourceType: row.triggerSourceType,
      } }] : [] };
    },
    matches: (candidate) => sanitizedFingerprint(candidate.projection) === expected,
  });
};

const deleteWebhook: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const id = typeof payload?.id === "string" ? payload.id : undefined;
  if (!id) return invalidInput(input);
  return singleReadHandler(input, {
    strategy: "delete",
    async read() {
      const listed = await input.clockify.listWebhooks();
      return { truncated: listed.truncated, rows: listed.rows.map((row) => ({ ref: { type: "webhook", id: row.id }, projection: {} })) };
    },
    matches: (candidate) => candidate.ref.id === id,
  });
};

const inviteUser = createFromList({
  entity: "user",
  async list(input) { return await input.clockify.listUsers() as unknown as ListResult<{ id: string } & Record<string, unknown>>; },
  project: (row) => ({ email: normalizedText(typeof row.email === "string" ? row.email : "") }),
});

const onboardInviteUser: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const baselineIds = Array.isArray(payload?.baselineUserIds) && payload.baselineUserIds.every((id) => typeof id === "string")
    ? payload.baselineUserIds as string[]
    : undefined;
  const email = typeof payload?.email === "string" ? normalizedText(payload.email) : undefined;
  if (!baselineIds || !email) return invalidInput(input);
  const baseline = new Set(baselineIds);
  return reconcileExternalMutation({
    strategy: "create",
    binding: input.binding,
    expected: { actionFingerprint: input.candidate.actionFingerprint, catalogHash: input.candidate.catalogHash },
    async readEvidence() {
      const listed = await input.clockify.listUsers();
      return {
        truncated: listed.truncated,
        rows: listed.rows.filter((row) => !baseline.has(row.id)).map((row) => ({
          ref: { type: "user", id: row.id },
          projection: { email: normalizedText(row.email ?? "") },
        })),
      };
    },
    matches: (candidate) => !!candidate.projection && typeof candidate.projection === "object" &&
      (candidate.projection as { email?: unknown }).email === email,
  });
};

const onboardGroupMembership: Handler = async (input) => {
  const evidence = input.step.evidence && typeof input.step.evidence === "object" && !Array.isArray(input.step.evidence)
    ? input.step.evidence as Record<string, unknown>
    : undefined;
  const groupId = typeof evidence?.groupId === "string" ? evidence.groupId : undefined;
  const expectedUserIds = Array.isArray(evidence?.expectedUserIds) && evidence.expectedUserIds.every((id) => typeof id === "string")
    ? evidence.expectedUserIds as string[]
    : undefined;
  if (!groupId || !expectedUserIds) return invalidInput(input);
  const expected = sanitizedFingerprint([...expectedUserIds].sort());
  return singleReadHandler(input, {
    strategy: "update",
    async read() {
      const listed = await input.clockify.listGroups();
      return {
        truncated: listed.truncated,
        rows: listed.rows.filter((row) => row.id === groupId).map((row) => ({
          ref: { type: "group", id: groupId },
          projection: [...(row.userIds ?? [])].sort(),
        })),
      };
    },
    matches: (candidate) => sanitizedFingerprint(candidate.projection) === expected,
  });
};

const updateUserRole: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const granteeId = typeof payload?.granteeId === "string" ? payload.granteeId : undefined;
  const role = typeof payload?.role === "string" ? payload.role : undefined;
  const entityId = typeof payload?.entityId === "string" ? payload.entityId : undefined;
  const sourceType = typeof payload?.sourceType === "string" ? payload.sourceType : undefined;
  if (!granteeId || !role || !entityId) return invalidInput(input);
  return singleReadHandler(input, {
    strategy: "state-command",
    async read() {
      const listed = await input.clockify.listUserRoleAssignments(granteeId);
      const matches = listed.rows.filter((row) => row.entityId === entityId && row.sourceType === sourceType);
      return { truncated: listed.truncated, rows: matches.map((row, index) => ({ ref: { type: "user-role", id: `${granteeId}:${index}` }, projection: row })) };
    },
    matches: (candidate) => !!candidate.projection && typeof candidate.projection === "object" &&
      (candidate.projection as { role?: unknown }).role === role,
  });
};

const updateUserRate: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const userId = typeof payload?.userId === "string" ? payload.userId : undefined;
  const rateKind = payload?.rateKind === "HOURLY" || payload?.rateKind === "COST" ? payload.rateKind : undefined;
  const amountMinor = typeof payload?.amountMinor === "number" ? payload.amountMinor : undefined;
  const since = typeof payload?.since === "string" ? payload.since : undefined;
  if (!userId || !rateKind || amountMinor === undefined) return invalidInput(input);
  return singleReadHandler(input, {
    strategy: "update",
    async read() {
      const row = await input.clockify.getWorkspaceMemberRate(userId, rateKind);
      return { truncated: false, rows: row ? [{ ref: { type: "user-rate", id: userId }, projection: row }] : [] };
    },
    matches: (candidate) => !!candidate.projection && typeof candidate.projection === "object" &&
      (candidate.projection as { amountMinor?: unknown }).amountMinor === amountMinor &&
      (since === undefined || (candidate.projection as { since?: unknown }).since === since),
  });
};

const deactivateUser: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const userId = typeof payload?.userId === "string" ? payload.userId : undefined;
  if (!userId) return invalidInput(input);
  return singleReadHandler(input, {
    strategy: "state-command",
    async read() {
      const listed = await input.clockify.listUsers();
      return { truncated: listed.truncated, rows: listed.rows.filter((row) => row.id === userId).map((row) => ({ ref: { type: "user", id: row.id }, projection: { status: row.status } })) };
    },
    matches: (candidate) => !!candidate.projection && typeof candidate.projection === "object" &&
      (candidate.projection as { status?: unknown }).status === "INACTIVE",
  });
};

const createGroup = createFromList({
  entity: "group",
  async list(input) { return await input.clockify.listGroups() as unknown as ListResult<{ id: string } & Record<string, unknown>>; },
  project: (row) => ({ name: normalizedText(typeof row.name === "string" ? row.name : "") }),
});

const updateGroup: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const id = typeof payload?.id === "string" ? payload.id : undefined;
  const name = typeof payload?.name === "string" ? payload.name : undefined;
  if (!id || !name) return invalidInput(input);
  return singleReadHandler(input, {
    strategy: "update",
    async read() {
      const listed = await input.clockify.listGroups();
      return { truncated: listed.truncated, rows: listed.rows.filter((row) => row.id === id).map((row) => ({ ref: { type: "group", id }, projection: { name: row.name } })) };
    },
    matches: (candidate) => !!candidate.projection && typeof candidate.projection === "object" &&
      (candidate.projection as { name?: unknown }).name === name,
  });
};

const deleteGroup: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const id = typeof payload?.id === "string" ? payload.id : undefined;
  if (!id) return invalidInput(input);
  return singleReadHandler(input, {
    strategy: "delete",
    async read() {
      const listed = await input.clockify.listGroups();
      return { truncated: listed.truncated, rows: listed.rows.map((row) => ({ ref: { type: "group", id: row.id }, projection: {} })) };
    },
    matches: (candidate) => candidate.ref.id === id,
  });
};

function targetSnapshotProjection(candidate: StartupReconciliationCandidate, relation: "target" | "parent", index = 0): Record<string, unknown> | undefined {
  const matching = (candidate.targetSnapshots ?? []).filter((value) => value && typeof value === "object" &&
    (value as { relation?: unknown }).relation === relation);
  const snapshot = matching[index] as { projection?: unknown } | undefined;
  return snapshot?.projection && typeof snapshot.projection === "object" && !Array.isArray(snapshot.projection)
    ? snapshot.projection as Record<string, unknown>
    : undefined;
}

const addUserToGroup: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const groupId = typeof payload?.groupId === "string" ? payload.groupId : undefined;
  const userIds = Array.isArray(payload?.userIds) && payload.userIds.every((id) => typeof id === "string") ? payload.userIds as string[] : undefined;
  const indexText = input.step.planStepId.match(/^add-user-to-group-(\d+)$/)?.[1];
  const index = indexText === undefined ? -1 : Number(indexText);
  const baseline = targetSnapshotProjection(input.candidate, "parent", index);
  const userId = userIds?.[index];
  const baselineUserIds = Array.isArray(baseline?.userIds) && baseline.userIds.every((id) => typeof id === "string") ? baseline.userIds as string[] : undefined;
  if (!groupId || !userId || !baselineUserIds) return invalidInput(input);
  const expected = sanitizedFingerprint([...baselineUserIds, userId].sort());
  return singleReadHandler(input, {
    strategy: "update",
    async read() {
      const listed = await input.clockify.listGroups();
      return { truncated: listed.truncated, rows: listed.rows.filter((row) => row.id === groupId).map((row) => ({ ref: { type: "group", id: groupId }, projection: [...(row.userIds ?? [])].sort() })) };
    },
    matches: (candidate) => sanitizedFingerprint(candidate.projection) === expected,
  });
};

const removeUserFromGroup: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const groupId = typeof payload?.groupId === "string" ? payload.groupId : undefined;
  const userId = typeof payload?.userId === "string" ? payload.userId : undefined;
  const baseline = targetSnapshotProjection(input.candidate, "parent");
  const baselineUserIds = Array.isArray(baseline?.userIds) && baseline.userIds.every((id) => typeof id === "string") ? baseline.userIds as string[] : undefined;
  if (!groupId || !userId || !baselineUserIds) return invalidInput(input);
  const expected = sanitizedFingerprint(baselineUserIds.filter((id) => id !== userId).sort());
  return singleReadHandler(input, {
    strategy: "update",
    async read() {
      const listed = await input.clockify.listGroups();
      return { truncated: listed.truncated, rows: listed.rows.filter((row) => row.id === groupId).map((row) => ({ ref: { type: "group", id: groupId }, projection: [...(row.userIds ?? [])].sort() })) };
    },
    matches: (candidate) => sanitizedFingerprint(candidate.projection) === expected,
  });
};

function approvalState(expectedState: (payload: Record<string, unknown>) => string | undefined): Handler {
  return async (input) => {
    const payload = payloadOf(input.candidate);
    if (!payload) return invalidInput(input);
    const id = typeof payload.id === "string"
      ? payload.id
      : typeof payload.approvalId === "string" ? payload.approvalId : undefined;
    const state = expectedState(payload);
    if (!id || !state) return invalidInput(input);
    return reconcileExternalMutation({
      strategy: "state-command",
      binding: input.binding,
      expected: { actionFingerprint: input.candidate.actionFingerprint, catalogHash: input.candidate.catalogHash },
      async readEvidence(): Promise<ListResult<ReconciliationCandidate>> {
        const row = await input.clockify.getApproval(id);
        return {
          truncated: false,
          rows: row ? [{ ref: { type: "approval", id: row.id }, projection: { state: row.state } }] : [],
        };
      },
      matches: (candidate) => candidate.ref.id === id &&
        !!candidate.projection && typeof candidate.projection === "object" &&
        (candidate.projection as { state?: unknown }).state === state,
    });
  };
}

const handlers = new Map<string, Handler>([
  ["clockify_approvals_submit\0submit-approval", submitApproval],
  ["clockify_approvals_approve\0set-approval-state", approvalState(() => "APPROVED")],
  ["clockify_approvals_reject\0set-approval-state", approvalState(() => "REJECTED")],
  ["clockify_approvals_withdraw\0withdraw-approval", approvalState((payload) => typeof payload.state === "string" ? payload.state : undefined)],
  ["clockify_approvals_resubmit\0resubmit-approval", approvalState(() => "PENDING")],
  ["clockify_scheduling_assignments_create\0create-assignment", createAssignment],
  ["clockify_scheduling_assignments_update\0update-assignment", updateAssignment],
  ["clockify_scheduling_assignments_delete\0delete-assignment", deleteAssignment],
  ["clockify_scheduling_publish\0publish-schedule", publishSchedule],
  ["clockify_webhooks_create\0create-webhook", createWebhook],
  ["clockify_webhooks_update\0update-webhook", updateWebhook],
  ["clockify_webhooks_delete\0delete-webhook", deleteWebhook],
  ["clockify_users_invite\0invite-user", inviteUser],
  ["clockify_onboard_user\0invite-user", onboardInviteUser],
  ["clockify_onboard_user\0add-user-to-group-*", onboardGroupMembership],
  ["clockify_users_role_update\0update-user-role", updateUserRole],
  ["clockify_users_rate_update\0update-user-rate", updateUserRate],
  ["clockify_users_deactivate\0deactivate-user", deactivateUser],
  ["clockify_groups_create\0create-group", createGroup],
  ["clockify_groups_update\0update-group", updateGroup],
  ["clockify_groups_delete\0delete-group", deleteGroup],
  ["clockify_groups_add_user\0add-user-to-group-*", addUserToGroup],
  ["clockify_groups_remove_user\0remove-user-from-group", removeUserFromGroup],
]);

// Keep the executable registry tied to the domain-owned, read-only metadata.
const declaredMetadata = [
  APPROVAL_STARTUP_RECONCILIATION,
  SCHEDULING_STARTUP_RECONCILIATION,
  WEBHOOK_STARTUP_RECONCILIATION,
  USER_GROUP_STARTUP_RECONCILIATION,
] as const;
for (const metadata of declaredMetadata) for (const [actionName, steps] of Object.entries(metadata)) {
  for (const planStepId of Object.keys(steps)) {
    if (!handlers.has(`${actionName}\0${planStepId}`)) throw new Error("startup_reconciliation_registry_incomplete");
  }
}
const compositeMetadata = Object.freeze({
  clockify_onboard_user: Object.freeze({
    "invite-user": "create",
    "add-user-to-group-*": "update",
  }),
} as const);
for (const [actionName, steps] of Object.entries(compositeMetadata)) {
  for (const planStepId of Object.keys(steps)) {
    if (!handlers.has(`${actionName}\0${planStepId}`)) throw new Error("startup_reconciliation_registry_incomplete");
  }
}

export function hasProductionStartupReconciliationHandler(actionName: string, planStepId: string): boolean {
  return handlers.has(`${actionName}\0${planStepId}`) ||
    (planStepId.startsWith("add-user-to-group-") && handlers.has(`${actionName}\0add-user-to-group-*`)) ||
    hasStructureStartupReconciliationHandler(actionName, planStepId) ||
    hasLeaveBillingStartupReconciliationHandler(actionName, planStepId);
}

for (const metadata of [
  ...declaredMetadata,
  compositeMetadata,
  STRUCTURE_STARTUP_RECONCILIATION,
  LEAVE_BILLING_STARTUP_RECONCILIATION,
]) {
  for (const [actionName, steps] of Object.entries(metadata)) {
    for (const planStepId of Object.keys(steps)) {
      if (!hasProductionStartupReconciliationHandler(actionName, planStepId)) {
        throw new Error("production_startup_reconciliation_registry_incomplete");
      }
    }
  }
}

export async function reconcileWithProductionRegistry(input: {
  binding: ReconciliationBinding;
  candidate: StartupReconciliationCandidate;
  step: StartupStep;
  clockify: StartupReconciliationReadClient;
}): Promise<ReconciliationResult> {
  const handler = handlers.get(`${input.candidate.actionName}\0${input.step.planStepId}`) ??
    (input.step.planStepId.startsWith("add-user-to-group-")
      ? handlers.get(`${input.candidate.actionName}\0add-user-to-group-*`)
      : undefined);
  if (handler) return handler(input);
  if (hasStructureStartupReconciliationHandler(input.candidate.actionName, input.step.planStepId)) {
    return reconcileWithStructureStartupRegistry(input);
  }
  if (hasLeaveBillingStartupReconciliationHandler(input.candidate.actionName, input.step.planStepId)) {
    return reconcileWithLeaveBillingStartupRegistry(input);
  }
  return {
    authoritative: false,
    reason: "handler_missing",
    binding: input.binding,
    evidence: { complete: false },
  };
}

/** Production startup orchestration. Handler lookup and catalog compatibility
 * happen before installation lookup/client construction. A client is built only
 * for the exact active installation owning the persisted operation. */
export function runProductionStartupReconciliation(input: {
  store: Pick<Store,
    | "listStartupReconciliationCandidates" | "recordOperationReconciliation"
    | "settleStartupReconciliation" | "getInstallation"
  >;
  clockifyForWorkspace(installation: Installation): StartupReconciliationReadClient;
  currentActionFingerprint?: typeof actionFingerprint;
  currentCatalogHash?: typeof catalogHash;
}): ReturnType<typeof runStoreStartupReconciliation> {
  return runStoreStartupReconciliation({
    store: input.store,
    currentActionFingerprint: input.currentActionFingerprint ?? actionFingerprint,
    currentCatalogHash: input.currentCatalogHash ?? catalogHash,
    async reconcile(binding) {
      const { candidate, step } = binding;
      const { candidate: _candidate, step: _step, ...persistedBinding } = binding;
      if (!hasProductionStartupReconciliationHandler(candidate.actionName, step.planStepId)) {
        return { authoritative: false, reason: "handler_missing", binding: persistedBinding, evidence: { complete: false } };
      }
      if (!candidate.workspaceId) {
        return { authoritative: false, reason: "invalid_evidence", binding: persistedBinding, evidence: { complete: false } };
      }
      const installation = input.store.getInstallation(candidate.workspaceId);
      if (!installation || installation.status !== "active") {
        return { authoritative: false, reason: "installation_unavailable", binding: persistedBinding, evidence: { complete: false } };
      }
      return reconcileWithProductionRegistry({
        binding: persistedBinding,
        candidate,
        step,
        clockify: input.clockifyForWorkspace(installation),
      });
    },
  });
}
