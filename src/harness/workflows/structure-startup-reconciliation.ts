import type { WorkspaceClient } from "../../clockify/client.js";
import type { ListResult } from "../../clockify/types.js";
import type {
  ReconciliationBinding,
  ReconciliationCandidate,
  ReconciliationResult,
  ReconciliationStrategy,
} from "../reconciliation.js";
import { reconcileExternalMutation } from "../reconciliation.js";
import { sanitizedFingerprint } from "../safe-json.js";
import type { StartupReconciliationCandidate } from "../startup-reconciliation.js";
import { projectMembershipsEquivalent } from "./membership-canonical.js";

type StartupStep = StartupReconciliationCandidate["steps"][number];

/** Structure startup handlers can only observe Clockify. Mutation and
 * compensation methods are absent by construction. */
export type StructureStartupReconciliationReadClient = Pick<WorkspaceClient,
  | "getRunningTimeEntry" | "getEntry" | "getEntries"
  | "listProjects" | "getProject" | "getProjectMutationState" | "getProjectMemberships"
  | "listTasks" | "getTask" | "prepareTaskUpdate"
  | "listClients" | "getClient" | "getClientMutationState"
  | "listTags" | "getTag" | "prepareTagUpdate"
>;

interface HandlerInput {
  binding: ReconciliationBinding;
  candidate: StartupReconciliationCandidate;
  step: StartupStep;
  clockify: StructureStartupReconciliationReadClient;
}

type Handler = (input: HandlerInput) => Promise<ReconciliationResult>;

const metadata = {
  clockify_start_timer: { "start-timer": "create" },
  clockify_stop_timer: { "stop-timer": "state-command" },
  clockify_log_work: { "log-time-entry": "create" },
  clockify_fix_entry: { "update-time-entry": "update" },
  clockify_entries_delete: { "delete-time-entry": "delete" },
  clockify_entries_mark_invoiced: { "mark-entries-invoiced": "state-command" },
  clockify_projects_create: { "create-project": "create" },
  clockify_projects_from_template: { "create-project-from-template": "create" },
  clockify_projects_update: { "update-project": "update" },
  clockify_projects_archive: { "archive-project": "state-command" },
  clockify_projects_delete: {
    "archive-project-for-delete": "state-command",
    "delete-project": "delete",
  },
  clockify_projects_rate_update: { "update-project-rate": "update" },
  clockify_projects_estimate_update: { "update-project-estimate": "update" },
  clockify_projects_memberships_update: { "update-project-memberships": "update" },
  clockify_tasks_create: { "create-task": "create" },
  clockify_tasks_update: { "update-task": "update" },
  clockify_tasks_delete: {
    "complete-task-for-delete": "state-command",
    "delete-task": "delete",
  },
  clockify_tasks_rate_update: { "update-task-rate": "update" },
  clockify_clients_create: { "create-client": "create", "enrich-client": "update" },
  clockify_clients_update: { "update-client": "update" },
  clockify_clients_delete: { "archive-client": "state-command", "delete-client": "delete" },
  clockify_tags_create: { "create-tag": "create" },
  clockify_tags_update: { "update-tag": "update" },
  clockify_tags_delete: { "delete-tag": "delete" },
  clockify_create_work_package: {
    "create-tag": "create",
    "create-client": "create",
    "create-project": "create",
    "create-task": "create",
    "start-timer": "create",
  },
  clockify_setup_project: {
    "create-project": "create",
    "add-project-members": "update",
    "set-project-rate-*": "update",
  },
  clockify_setup_task: { "create-task": "create", "set-task-rate": "update" },
} as const;

for (const steps of Object.values(metadata)) Object.freeze(steps);

/** Exact Task 7 action/step declarations owned by this domain. */
export const STRUCTURE_STARTUP_RECONCILIATION = Object.freeze(metadata);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function payloadOf(candidate: StartupReconciliationCandidate): Record<string, unknown> | undefined {
  const operation = record(candidate.operation);
  return record(operation?.payload) ?? operation;
}

function evidenceOf(step: StartupStep): Record<string, unknown> | undefined {
  return record(step.evidence);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function baselineIds(input: HandlerInput): string[] | undefined {
  const payload = payloadOf(input.candidate);
  const evidence = evidenceOf(input.step);
  const preDispatch = record(evidence?.preDispatch);
  return stringArray(payload?.beforeIds) ?? stringArray(preDispatch?.ids) ??
    stringArray(preDispatch?.beforeIds) ?? stringArray(evidence?.beforeIds);
}

function invalidInput(input: HandlerInput): ReconciliationResult {
  return {
    authoritative: false,
    reason: "invalid_evidence",
    binding: input.binding,
    evidence: { complete: false },
  };
}

function reconcile(input: HandlerInput, options: {
  strategy: ReconciliationStrategy;
  readEvidence(): Promise<ListResult<ReconciliationCandidate>>;
  matches(candidate: ReconciliationCandidate): boolean;
}): Promise<ReconciliationResult> {
  return reconcileExternalMutation({
    strategy: options.strategy,
    binding: input.binding,
    expected: {
      actionFingerprint: input.candidate.actionFingerprint,
      catalogHash: input.candidate.catalogHash,
    },
    readEvidence: () => options.readEvidence(),
    matches: (candidate) => options.matches(candidate),
  });
}

function candidate(type: string, id: string, projection: unknown): ReconciliationCandidate {
  return { ref: { type, id }, projection };
}

function containsExpected(actual: unknown, expected: Record<string, unknown>): boolean {
  const value = record(actual);
  return !!value && Object.entries(expected).every(([key, expectedValue]) =>
    JSON.stringify(value[key]) === JSON.stringify(expectedValue));
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function membershipFingerprint(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.some((row) => !record(row))) return undefined;
  return sanitizedFingerprint(value.map((row) => ({ ...record(row)!, userId: String(record(row)!.userId) }))
    .sort((a, b) => a.userId.localeCompare(b.userId)));
}

function createFromList<T extends { id: string }>(input: HandlerInput, options: {
  type: string;
  list(): Promise<ListResult<T>>;
  project(row: T): unknown;
  matches(row: T): boolean;
}): Promise<ReconciliationResult> | ReconciliationResult {
  const beforeIds = baselineIds(input);
  if (!beforeIds) return invalidInput(input);
  const baseline = new Set(beforeIds);
  return reconcile(input, {
    strategy: "create",
    async readEvidence() {
      const listed = await options.list();
      return {
        truncated: listed.truncated,
        rows: listed.rows.filter((row) => !baseline.has(row.id)).map((row) =>
          candidate(options.type, row.id, options.project(row))),
      };
    },
    matches: (item) => options.matches(item.projection as T),
  });
}

function singleRead(input: HandlerInput, options: {
  strategy: ReconciliationStrategy;
  read(): Promise<ReconciliationCandidate | undefined>;
  matches(candidate: ReconciliationCandidate): boolean;
}): Promise<ReconciliationResult> {
  return reconcile(input, {
    strategy: options.strategy,
    async readEvidence() {
      const row = await options.read();
      return { rows: row ? [row] : [], truncated: false };
    },
    matches: (candidate) => options.matches(candidate),
  });
}

const createTag: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const body = record(payload?.body);
  const name = stringValue(body?.name);
  if (!name) return invalidInput(input);
  return await createFromList(input, {
    type: "tag",
    list: () => input.clockify.listTags({ archived: false }),
    project: (row) => row,
    matches: (row) => row.name === name,
  });
};

const createProject: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const body = record(payload?.body);
  if (!body || !stringValue(body.name)) return invalidInput(input);
  const beforeIds = baselineIds(input);
  if (!beforeIds) return invalidInput(input);
  const baseline = new Set(beforeIds);
  return reconcile(input, {
    strategy: "create",
    async readEvidence() {
      const listed = await input.clockify.listProjects({ archived: false });
      const rows: ReconciliationCandidate[] = [];
      for (const row of listed.rows) {
        if (baseline.has(row.id) || row.name !== body.name) continue;
        const raw = await input.clockify.getProjectMutationState(row.id);
        if (raw) rows.push(candidate("project", row.id, raw));
      }
      return { rows, truncated: listed.truncated };
    },
    matches: (item) => containsExpected(item.projection, body),
  });
};

const createProjectFromTemplate: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const body = record(payload?.body);
  const name = stringValue(body?.name);
  if (!name) return invalidInput(input);
  const beforeIds = baselineIds(input);
  if (!beforeIds) return invalidInput(input);
  const baseline = new Set(beforeIds);
  return reconcile(input, {
    strategy: "create",
    async readEvidence() {
      const listed = await input.clockify.listProjects({ archived: false });
      return {
        truncated: listed.truncated,
        rows: listed.rows.filter((row) => !baseline.has(row.id) && row.name === name)
          .map((row) => candidate("project", row.id, { name: row.name })),
      };
    },
    matches: (item) => record(item.projection)?.name === name,
  });
};

const createTask: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const body = record(payload?.body);
  const projectId = stringValue(body?.projectId);
  const name = stringValue(body?.name);
  if (!body || !projectId || !name) return invalidInput(input);
  return await createFromList(input, {
    type: "task",
    list: () => input.clockify.listTasks(projectId),
    project: (row) => row,
    matches: (row) => row.name === name &&
      JSON.stringify(row.assigneeIds ?? []) === JSON.stringify(body.assigneeIds ?? []),
  });
};

const createTimeEntry: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const body = record(payload?.body);
  const start = stringValue(body?.start);
  const adminUserId = stringValue(input.candidate.adminUserId);
  if (!body || !start || !adminUserId) return invalidInput(input);
  const end = new Date(Date.parse(start) + 1).toISOString();
  return await createFromList(input, {
    type: "time_entry",
    list: () => input.clockify.getEntries({ userId: adminUserId, start, end }),
    project: (row) => row,
    matches: (row) => row.start === start && row.end === (body.end ?? null) &&
      row.description === body.description && row.projectId === body.projectId && row.taskId === body.taskId &&
      JSON.stringify(row.tagIds ?? []) === JSON.stringify(body.tagIds ?? []) && row.billable === body.billable,
  });
};

const startTimer: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const body = record(payload?.body);
  const userId = stringValue(body?.userId);
  if (!body || !userId) return invalidInput(input);
  return singleRead(input, {
    strategy: "create",
    async read() {
      const row = await input.clockify.getRunningTimeEntry(userId);
      return row ? candidate("time_entry", row.id, row) : undefined;
    },
    matches: (item) => {
      const row = record(item.projection);
      return !!row && row.start === body.start && row.description === body.description &&
        row.projectId === body.projectId && row.taskId === body.taskId &&
        JSON.stringify(row.tagIds ?? []) === JSON.stringify(body.tagIds ?? []) && row.billable === body.billable;
    },
  });
};

const stopTimer: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const userId = stringValue(payload?.userId);
  if (!userId) return invalidInput(input);
  const snapshots = Array.isArray(payload?.targetSnapshots) ? payload.targetSnapshots : [];
  const targetId = stringValue(record(record(snapshots[0])?.ref)?.id);
  return singleRead(input, {
    strategy: "state-command",
    async read() {
      if (targetId) {
        const row = await input.clockify.getEntry(targetId);
        return row ? candidate("time_entry", targetId, row) : undefined;
      }
      const running = await input.clockify.getRunningTimeEntry(userId);
      return candidate("timer_state", userId, { stopped: running == null });
    },
    matches: (item) => targetId
      ? Boolean(record(item.projection)?.end)
      : record(item.projection)?.stopped === true,
  });
};

const updateTimeEntry: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const id = stringValue(payload?.id);
  if (!id) return invalidInput(input);
  const expected = {
    description: payload?.description,
    projectId: payload?.projectId,
    taskId: payload?.taskId,
    tagIds: payload?.tagIds,
    billable: payload?.billable,
  };
  return singleRead(input, {
    strategy: "update",
    async read() {
      const row = await input.clockify.getEntry(id);
      return row ? candidate("time_entry", id, row) : undefined;
    },
    matches: (item) => {
      const row = record(item.projection);
      return !!row && Object.entries(expected).every(([key, value]) =>
        value === undefined || JSON.stringify(row[key]) === JSON.stringify(value));
    },
  });
};

function deleteByRead(input: HandlerInput, type: string, id: string, read: () => Promise<unknown>): Promise<ReconciliationResult> {
  return singleRead(input, {
    strategy: "delete",
    async read() {
      const row = await read();
      return row == null ? undefined : candidate(type, id, row);
    },
    matches: (item) => item.ref.id === id,
  });
}

const deleteTimeEntry: Handler = async (input) => {
  const id = stringValue(payloadOf(input.candidate)?.id);
  return id ? deleteByRead(input, "time_entry", id, () => input.clockify.getEntry(id)) : invalidInput(input);
};

const markEntriesInvoiced: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const ids = stringArray(payload?.ids);
  if (!ids || typeof payload?.invoiced !== "boolean") return invalidInput(input);
  return singleRead(input, {
    strategy: "state-command",
    async read() {
      const rows = await Promise.all(ids.map((id) => input.clockify.getEntry(id)));
      return candidate("time_entries", ids.join(","), rows);
    },
    matches: (item) => Array.isArray(item.projection) && item.projection.length === ids.length &&
      item.projection.every((row) => record(row)?.invoiced === payload.invoiced),
  });
};

function rawReplacement(input: HandlerInput, type: string, id: string, expected: unknown, read: () => Promise<unknown>): Promise<ReconciliationResult> {
  return singleRead(input, {
    strategy: "update",
    async read() {
      const row = await read();
      return row == null ? undefined : candidate(type, id, row);
    },
    matches: (item) => sanitizedFingerprint(item.projection) === sanitizedFingerprint(expected),
  });
}

const updateProject: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const id = stringValue(payload?.id);
  const body = record(payload?.body);
  return id && body
    ? rawReplacement(input, "project", id, body, () => input.clockify.getProjectMutationState(id))
    : invalidInput(input);
};

const projectArchived: Handler = async (input) => {
  const id = stringValue(payloadOf(input.candidate)?.id);
  if (!id) return invalidInput(input);
  return singleRead(input, {
    strategy: "state-command",
    async read() {
      const row = await input.clockify.getProject(id);
      return row ? candidate("project", id, row) : undefined;
    },
    matches: (item) => record(item.projection)?.archived === true,
  });
};

const deleteProject: Handler = async (input) => {
  const id = stringValue(payloadOf(input.candidate)?.id);
  return id ? deleteByRead(input, "project", id, () => input.clockify.getProject(id)) : invalidInput(input);
};

const updateProjectRate: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const id = stringValue(payload?.projectId);
  const key = payload?.rateKind === "COST" ? "costRate" : payload?.rateKind === "HOURLY" ? "hourlyRate" : undefined;
  if (!id || !key || typeof payload?.amountMinor !== "number") return invalidInput(input);
  return singleRead(input, {
    strategy: "update",
    async read() {
      const row = await input.clockify.getProject(id);
      return row ? candidate("project", id, row) : undefined;
    },
    matches: (item) => record(record(item.projection)?.[key])?.amount === payload.amountMinor,
  });
};

const updateProjectEstimate: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const id = stringValue(payload?.id);
  const fields = record(payload?.fields);
  if (!id || !fields) return invalidInput(input);
  return singleRead(input, {
    strategy: "update",
    async read() {
      const row = await input.clockify.getProject(id);
      return row ? candidate("project", id, row) : undefined;
    },
    matches: (item) => containsExpected(item.projection, fields),
  });
};

const updateProjectMemberships: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const id = stringValue(payload?.id);
  if (!id || !Array.isArray(payload?.memberships)) return invalidInput(input);
  return reconcile(input, {
    strategy: "update",
    async readEvidence() {
      const listed = await input.clockify.getProjectMemberships(id);
      return {
        truncated: listed.truncated,
        rows: [candidate("project", id, listed.rows)],
      };
    },
    matches: (item) => Array.isArray(item.projection) && projectMembershipsEquivalent(
      payload.memberships as Array<Record<string, unknown>>,
      item.projection as Array<Record<string, unknown>>,
    ),
  });
};

const updateTask: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const projectId = stringValue(payload?.projectId);
  const id = stringValue(payload?.id);
  const body = record(payload?.body);
  return projectId && id && body
    ? rawReplacement(input, "task", id, body, () => input.clockify.prepareTaskUpdate(projectId, id, {}))
    : invalidInput(input);
};

const completeTask: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const projectId = stringValue(payload?.projectId);
  const id = stringValue(payload?.id);
  if (!projectId || !id) return invalidInput(input);
  return singleRead(input, {
    strategy: "state-command",
    async read() {
      const row = await input.clockify.prepareTaskUpdate(projectId, id, {});
      return candidate("task", id, row);
    },
    matches: (item) => record(item.projection)?.status === "DONE",
  });
};

const deleteTask: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const projectId = stringValue(payload?.projectId);
  const id = stringValue(payload?.id);
  return projectId && id
    ? deleteByRead(input, "task", id, () => input.clockify.getTask(projectId, id))
    : invalidInput(input);
};

const updateTaskRate: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const projectId = stringValue(payload?.projectId);
  const taskId = stringValue(payload?.taskId);
  const key = payload?.rateKind === "COST" ? "costRate" : payload?.rateKind === "HOURLY" ? "hourlyRate" : undefined;
  if (!projectId || !taskId || !key || typeof payload?.amountMinor !== "number") return invalidInput(input);
  return singleRead(input, {
    strategy: "update",
    async read() {
      const row = await input.clockify.getTask(projectId, taskId);
      return row ? candidate("task", taskId, row) : undefined;
    },
    matches: (item) => record(record(item.projection)?.[key])?.amount === payload.amountMinor,
  });
};

const createClient: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const base = record(payload?.base);
  const name = stringValue(base?.name);
  const beforeIds = baselineIds(input);
  if (!base || !name || !beforeIds) return invalidInput(input);
  const baseline = new Set(beforeIds);
  return reconcile(input, {
    strategy: "create",
    async readEvidence() {
      const listed = await input.clockify.listClients({ archived: false });
      const rows: ReconciliationCandidate[] = [];
      for (const row of listed.rows) {
        if (baseline.has(row.id) || row.name !== name) continue;
        const raw = await input.clockify.getClientMutationState(row.id);
        if (raw) rows.push(candidate("client", row.id, raw));
      }
      return { rows, truncated: listed.truncated };
    },
    matches: (item) => containsExpected(item.projection, base),
  });
};

const enrichClient: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const enrichment = record(payload?.enrichment);
  const evidence = evidenceOf(input.step);
  const id = stringValue(evidence?.clientId);
  if (!id || !enrichment) return invalidInput(input);
  return singleRead(input, {
    strategy: "update",
    async read() {
      const row = await input.clockify.getClientMutationState(id);
      return row ? candidate("client", id, row) : undefined;
    },
    matches: (item) => containsExpected(item.projection, enrichment),
  });
};

const updateClient: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const id = stringValue(payload?.id);
  const body = record(payload?.body);
  return id && body
    ? rawReplacement(input, "client", id, body, () => input.clockify.getClientMutationState(id))
    : invalidInput(input);
};

const clientArchived: Handler = async (input) => {
  const id = stringValue(payloadOf(input.candidate)?.id);
  if (!id) return invalidInput(input);
  return singleRead(input, {
    strategy: "state-command",
    async read() {
      const row = await input.clockify.getClient(id);
      return row ? candidate("client", id, row) : undefined;
    },
    matches: (item) => record(item.projection)?.archived === true,
  });
};

const deleteClient: Handler = async (input) => {
  const id = stringValue(payloadOf(input.candidate)?.id);
  return id ? deleteByRead(input, "client", id, () => input.clockify.getClient(id)) : invalidInput(input);
};

const updateTag: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const id = stringValue(payload?.id);
  const patch = record(payload?.patch);
  if (!id || !patch) return invalidInput(input);
  return singleRead(input, {
    strategy: "update",
    async read() {
      const row = await input.clockify.getTag(id);
      return row ? candidate("tag", id, row) : undefined;
    },
    matches: (item) => containsExpected(item.projection, patch),
  });
};

const deleteTag: Handler = async (input) => {
  const id = stringValue(payloadOf(input.candidate)?.id);
  return id ? deleteByRead(input, "tag", id, () => input.clockify.getTag(id)) : invalidInput(input);
};

function workPackageExpected(input: HandlerInput): Record<string, unknown> | undefined {
  const evidence = evidenceOf(input.step);
  return record(evidence?.expected) ?? record(record(evidence?.preDispatch)?.expected);
}

const workPackageCreateTag: Handler = async (input) => {
  const name = stringValue(record(payloadOf(input.candidate)?.tag)?.name);
  if (!name) return invalidInput(input);
  return await createFromList(input, {
    type: "tag", list: () => input.clockify.listTags({ archived: false }), project: (row) => row,
    matches: (row) => normalized(row.name) === normalized(name),
  });
};

const workPackageCreateClient: Handler = async (input) => {
  const name = stringValue(record(payloadOf(input.candidate)?.client)?.name);
  if (!name) return invalidInput(input);
  return await createFromList(input, {
    type: "client", list: () => input.clockify.listClients({ archived: false }), project: (row) => row,
    matches: (row) => normalized(row.name) === normalized(name),
  });
};

const workPackageCreateProject: Handler = async (input) => {
  const expected = workPackageExpected(input);
  const name = stringValue(expected?.name);
  if (!name) return invalidInput(input);
  const clientId = stringValue(expected?.clientId);
  return await createFromList(input, {
    type: "project",
    list: () => input.clockify.listProjects({ archived: false, ...(clientId ? { clientIds: [clientId] } : {}) }),
    project: (row) => row,
    matches: (row) => normalized(row.name) === normalized(name) && (clientId === undefined || row.clientId === clientId),
  });
};

const workPackageCreateTask: Handler = async (input) => {
  const expected = workPackageExpected(input);
  const projectId = stringValue(expected?.projectId);
  const name = stringValue(expected?.name);
  if (!projectId || !name) return invalidInput(input);
  return await createFromList(input, {
    type: "task", list: () => input.clockify.listTasks(projectId), project: (row) => row,
    matches: (row) => normalized(row.name) === normalized(name),
  });
};

const workPackageStartTimer: Handler = async (input) => {
  const evidence = evidenceOf(input.step);
  const timerInput = record(evidence?.input);
  const userId = stringValue(timerInput?.userId);
  if (!timerInput || !userId) return invalidInput(input);
  const priorRunningId = stringValue(evidence?.priorRunningId);
  return singleRead(input, {
    strategy: "create",
    async read() {
      const row = await input.clockify.getRunningTimeEntry(userId);
      return row ? candidate("time_entry", row.id, row) : undefined;
    },
    matches: (item) => {
      const row = record(item.projection);
      return !!row && item.ref.id !== priorRunningId && row.projectId === timerInput.projectId &&
        row.taskId === timerInput.taskId && row.description === timerInput.description &&
        row.billable === timerInput.billable && row.start === timerInput.start;
    },
  });
};

const setupProjectCreate: Handler = async (input) => {
  const body = record(evidenceOf(input.step)?.body);
  const beforeIds = baselineIds(input);
  if (!body || !stringValue(body.name) || !beforeIds) return invalidInput(input);
  const baseline = new Set(beforeIds);
  return reconcile(input, {
    strategy: "create",
    async readEvidence() {
      const listed = await input.clockify.listProjects({ archived: false });
      const rows: ReconciliationCandidate[] = [];
      for (const row of listed.rows) {
        if (baseline.has(row.id) || row.name !== body.name) continue;
        const raw = await input.clockify.getProjectMutationState(row.id);
        if (raw) rows.push(candidate("project", row.id, raw));
      }
      return { rows, truncated: listed.truncated };
    },
    matches: (item) => containsExpected(item.projection, body),
  });
};

const setupProjectMembers: Handler = async (input) => {
  const evidence = evidenceOf(input.step);
  const projectId = stringValue(evidence?.projectId);
  if (!projectId || !Array.isArray(evidence?.memberships)) return invalidInput(input);
  return reconcile(input, {
    strategy: "update",
    async readEvidence() {
      const listed = await input.clockify.getProjectMemberships(projectId);
      return { rows: [candidate("project", projectId, listed.rows)], truncated: listed.truncated };
    },
    matches: (item) => membershipFingerprint(item.projection) === membershipFingerprint(evidence.memberships),
  });
};

const setupProjectRate: Handler = async (input) => {
  const evidence = evidenceOf(input.step);
  const projectId = stringValue(evidence?.projectId);
  const userId = stringValue(evidence?.userId);
  const key = evidence?.kind === "cost" ? "costRate" : evidence?.kind === "hourly" ? "hourlyRate" : undefined;
  const expectedMember = record(evidence?.expectedMember);
  if (!projectId || !userId || !key || typeof evidence?.amountMinor !== "number" || !expectedMember) return invalidInput(input);
  return reconcile(input, {
    strategy: "update",
    async readEvidence() {
      const listed = await input.clockify.getProjectMemberships(projectId);
      return {
        truncated: listed.truncated,
        rows: listed.rows.filter((row) => String(row.userId) === userId)
          .map((row) => candidate("project_member", userId, row)),
      };
    },
    matches: (item) => sanitizedFingerprint(item.projection) === sanitizedFingerprint(expectedMember),
  });
};

const setupTaskCreate: Handler = async (input) => {
  const evidence = evidenceOf(input.step);
  const body = record(evidence?.body);
  const projectId = stringValue(body?.projectId);
  const name = stringValue(body?.name);
  const beforeIds = baselineIds(input);
  if (!body || !projectId || !name || !beforeIds) return invalidInput(input);
  const baseline = new Set(beforeIds);
  const expectedAssignees = stringArray(body.assigneeIds) ?? [];
  return reconcile(input, {
    strategy: "create",
    async readEvidence() {
      const listed = await input.clockify.listTasks(projectId);
      return {
        truncated: listed.truncated,
        rows: listed.rows.filter((row) => !baseline.has(row.id)).map((row) => candidate("task", row.id, row)),
      };
    },
    matches: (item) => {
      const row = record(item.projection);
      const assignees = stringArray(row?.assigneeIds) ?? [];
      return row?.name === name && sanitizedFingerprint([...assignees].sort()) === sanitizedFingerprint([...expectedAssignees].sort());
    },
  });
};

const setupTaskRate: Handler = async (input) => {
  const evidence = evidenceOf(input.step);
  const projectId = stringValue(evidence?.projectId);
  const taskId = stringValue(evidence?.taskId);
  const rate = record(evidence?.rate);
  const key = rate?.kind === "cost" ? "costRate" : rate?.kind === "hourly" ? "hourlyRate" : undefined;
  if (!projectId || !taskId || !key || typeof rate?.amountMinor !== "number") return invalidInput(input);
  return singleRead(input, {
    strategy: "update",
    async read() {
      const row = await input.clockify.prepareTaskUpdate(projectId, taskId, {});
      return candidate("task", taskId, row);
    },
    matches: (item) => record(record(item.projection)?.[key])?.amount === rate.amountMinor,
  });
};

const handlers = new Map<string, Handler>([
  ["clockify_start_timer\0start-timer", startTimer],
  ["clockify_stop_timer\0stop-timer", stopTimer],
  ["clockify_log_work\0log-time-entry", createTimeEntry],
  ["clockify_fix_entry\0update-time-entry", updateTimeEntry],
  ["clockify_entries_delete\0delete-time-entry", deleteTimeEntry],
  ["clockify_entries_mark_invoiced\0mark-entries-invoiced", markEntriesInvoiced],
  ["clockify_projects_create\0create-project", createProject],
  ["clockify_projects_from_template\0create-project-from-template", createProjectFromTemplate],
  ["clockify_projects_update\0update-project", updateProject],
  ["clockify_projects_archive\0archive-project", projectArchived],
  ["clockify_projects_delete\0archive-project-for-delete", projectArchived],
  ["clockify_projects_delete\0delete-project", deleteProject],
  ["clockify_projects_rate_update\0update-project-rate", updateProjectRate],
  ["clockify_projects_estimate_update\0update-project-estimate", updateProjectEstimate],
  ["clockify_projects_memberships_update\0update-project-memberships", updateProjectMemberships],
  ["clockify_tasks_create\0create-task", createTask],
  ["clockify_tasks_update\0update-task", updateTask],
  ["clockify_tasks_delete\0complete-task-for-delete", completeTask],
  ["clockify_tasks_delete\0delete-task", deleteTask],
  ["clockify_tasks_rate_update\0update-task-rate", updateTaskRate],
  ["clockify_clients_create\0create-client", createClient],
  ["clockify_clients_create\0enrich-client", enrichClient],
  ["clockify_clients_update\0update-client", updateClient],
  ["clockify_clients_delete\0archive-client", clientArchived],
  ["clockify_clients_delete\0delete-client", deleteClient],
  ["clockify_tags_create\0create-tag", createTag],
  ["clockify_tags_update\0update-tag", updateTag],
  ["clockify_tags_delete\0delete-tag", deleteTag],
  ["clockify_create_work_package\0create-tag", workPackageCreateTag],
  ["clockify_create_work_package\0create-client", workPackageCreateClient],
  ["clockify_create_work_package\0create-project", workPackageCreateProject],
  ["clockify_create_work_package\0create-task", workPackageCreateTask],
  ["clockify_create_work_package\0start-timer", workPackageStartTimer],
  ["clockify_setup_project\0create-project", setupProjectCreate],
  ["clockify_setup_project\0add-project-members", setupProjectMembers],
  ["clockify_setup_project\0set-project-rate-*", setupProjectRate],
  ["clockify_setup_task\0create-task", setupTaskCreate],
  ["clockify_setup_task\0set-task-rate", setupTaskRate],
]);

const declaredKeys = Object.entries(STRUCTURE_STARTUP_RECONCILIATION).flatMap(([actionName, steps]) =>
  Object.keys(steps).map((planStepId) => `${actionName}\0${planStepId}`));
if (declaredKeys.length !== handlers.size || declaredKeys.some((key) => !handlers.has(key))) {
  throw new Error("structure_startup_reconciliation_registry_incomplete");
}

export const STRUCTURE_STARTUP_RECONCILIATION_HANDLER_COUNT = handlers.size;

export function hasStructureStartupReconciliationHandler(actionName: string, planStepId: string): boolean {
  return handlers.has(`${actionName}\0${planStepId}`) ||
    (actionName === "clockify_setup_project" && /^set-project-rate-\d+$/.test(planStepId) &&
      handlers.has(`${actionName}\0set-project-rate-*`));
}

export async function reconcileWithStructureStartupRegistry(input: HandlerInput): Promise<ReconciliationResult> {
  const handler = handlers.get(`${input.candidate.actionName}\0${input.step.planStepId}`) ??
    (input.candidate.actionName === "clockify_setup_project" && /^set-project-rate-\d+$/.test(input.step.planStepId)
      ? handlers.get(`${input.candidate.actionName}\0set-project-rate-*`)
      : undefined);
  if (!handler) {
    return {
      authoritative: false,
      reason: "handler_missing",
      binding: input.binding,
      evidence: { complete: false },
    };
  }
  return handler(input);
}
