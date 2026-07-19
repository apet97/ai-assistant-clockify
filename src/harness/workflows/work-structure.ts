import { z } from "zod";
import {
  defineAction,
  type ActionContext,
  type ActionDefinition,
  type CommitResult,
  type ConfirmableOperation,
  type BoundedPreparedSafeWrite,
  type SafeWritePreparationResult,
  type TargetSnapshot,
} from "../action.js";
import type { EntitySummary } from "../../clockify/client.js";
import type { ListResult } from "../../clockify/types.js";
import { canWrite, type FeatureGroup } from "../permissions.js";
import { listReceipt, successReceipt, errorReceipt } from "../receipts.js";
import { nowIso } from "../../durations.js";
import { matchByName, suggestOptions } from "./resolve.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { executeDurableRiskyStep } from "../durable-risky-write.js";
import { AmbiguousWriteOutcome, DefinitiveWriteFailure } from "../../clockify/write-outcome.js";
import { captureTargetSnapshot, verifyTargetSnapshots } from "../target-snapshots.js";
import { dispatchWithReconciliation, reconcileCreate } from "./structure-durable.js";
import { dynamicMutationPlan, fetchCompositeSnapshot } from "./composite-durable.js";
import type { EntityRef } from "../receipts.js";

/**
 * Fold the shapes the planner naturally emits into the canonical nested form
 * before validation: a bare string for an entity (`project: "Apollo"`) and the
 * flat `*Name` aliases (`projectName: "Apollo"`) both mean `{ name: ... }`. This
 * keeps the "create a project and start a timer on it" one-turn request from
 * dead-ending on a schema mismatch (the planner cannot be relied on to nest).
 */
function normalizeWorkPackageArgs(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const r: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of ["tag", "client", "project", "task"]) {
    if (typeof r[key] === "string" && (r[key] as string).trim()) r[key] = { name: (r[key] as string).trim() };
  }
  const aliases: Array<[flat: string, nested: string]> = [
    ["tagName", "tag"],
    ["projectName", "project"],
    ["taskName", "task"],
  ];
  for (const [flat, nested] of aliases) {
    if (r[nested] === undefined && typeof r[flat] === "string" && (r[flat] as string).trim()) {
      r[nested] = { name: (r[flat] as string).trim() };
    }
    delete r[flat];
  }
  return r;
}

/**
 * Work-structure safe-write + read workflows (SPEC "Safe Writes" / reads).
 * `create_work_package` creates or reuses a client / project / task / tag by
 * name; `list_entities` and `get_entity` are reads that route the policy gate to
 * the entity's feature group. Ambiguous parent identity stops and asks.
 */

const LISTABLE_ENTITY_TYPES = [
  "tag",
  "project",
  "client",
  "task",
  "user",
  "expense",
  "webhook",
] as const;
type ListableEntityType = (typeof LISTABLE_ENTITY_TYPES)[number];

const LIST_ENTITY_GROUP: Record<ListableEntityType, FeatureGroup> = {
  tag: "work_structure",
  project: "work_structure",
  client: "work_structure",
  task: "work_structure",
  user: "users_groups",
  expense: "expenses",
  webhook: "webhooks",
};

async function listByType(
  ctx: ActionContext,
  type: ListableEntityType,
  projectId?: string,
): Promise<ListResult<EntitySummary>> {
  switch (type) {
    case "tag":
      return ctx.clockify.listTags();
    case "project":
      return ctx.clockify.listProjects();
    case "client":
      return ctx.clockify.listClients();
    case "task":
      return ctx.clockify.listTasks(projectId as string);
    case "user":
      return ctx.clockify.listUsers();
    case "expense":
      return ctx.clockify.listExpenses();
    case "webhook":
      return ctx.clockify.listWebhooks();
  }
}

/**
 * Fetch ONE entity by id, returning `null` when it doesn't exist (the
 * `entity: null` receipt shape `get_entity` has always produced for a missing
 * id). Prefer the typed per-type GET so an id that has fallen off the ACTIVE
 * list (e.g. an archived project) still resolves — `listByType` only sees the
 * active set, so a list-then-find missed archived rows. `user` has no typed GET
 * port (only `listUsers`), so it keeps the list-then-find fallback. Never throws
 * for a missing id — it resolves to `null` like the list-find path did.
 */
async function getByType(
  ctx: ActionContext,
  type: ListableEntityType,
  id: string,
  projectId?: string,
): Promise<EntitySummary | null | undefined> {
  switch (type) {
    case "tag":
      return ctx.clockify.getTag(id);
    case "project":
      return ctx.clockify.getProject(id);
    case "client":
      return ctx.clockify.getClient(id);
    case "task":
      return ctx.clockify.getTask(projectId as string, id);
    case "expense":
      return ctx.clockify.getExpense(id);
    case "webhook":
      return ctx.clockify.getWebhook(id);
    case "user":
      // No typed user GET port — fall back to list-then-find.
      {
        const users = await ctx.clockify.listUsers();
        const user = users.rows.find((entity) => entity.id === id);
        return user ?? (users.truncated ? undefined : null);
      }
  }
}

type WorkPackageOperation = {
  tag?: { name: string; existing?: { id: string; name: string } };
  client?: { name: string; existing?: { id: string; name: string } };
  project?: { name: string; existing?: { id: string; name: string }; existingClientId?: string; clientFromStep: boolean };
  task?: { name: string; existing?: { id: string; name: string; projectId: string }; projectFromStep: boolean };
  timer?: { description?: string; billable?: boolean; start: string };
  timerDenied: boolean;
  targetSnapshots: TargetSnapshot[];
};

async function prepareWorkPackage(ctx: ActionContext, args: {
  tag?: { name: string };
  client?: { name: string };
  project?: { name: string; clientName?: string };
  task?: { name: string };
  startTimer?: boolean | { description?: string; billable?: boolean };
}): Promise<SafeWritePreparationResult> {
  if (args.task && !args.project) {
    return { kind: "clarify", clarify: `To create task "${args.task.name}" I need a project. Which project should it belong to?` };
  }
  if (args.startTimer && !args.project) {
    return { kind: "clarify", clarify: "To start a timer I need a project. Add a project to create or reuse, or start the timer separately." };
  }
  const [tagsResult, clientsResult, projectsResult] = await Promise.all([
    args.tag ? ctx.clockify.listTags() : Promise.resolve({ rows: [], truncated: false }),
    args.client || args.project?.clientName ? ctx.clockify.listClients() : Promise.resolve({ rows: [], truncated: false }),
    args.project ? ctx.clockify.listProjects() : Promise.resolve({ rows: [], truncated: false }),
  ]);
  const tagMatch = args.tag ? matchByName(tagsResult.rows, args.tag.name) : undefined;
  if (args.tag && tagMatch?.kind === "many") return safeAmbiguous("tag", args.tag.name, tagMatch.matches);
  if (args.tag && tagsResult.truncated) return safeIncompleteIdentity("tag", args.tag.name);
  const clientMatch = args.client ? matchByName(clientsResult.rows, args.client.name) : undefined;
  if (args.client && clientMatch?.kind === "many") return safeAmbiguous("client", args.client.name, clientMatch.matches);
  if (args.client && clientsResult.truncated) return safeIncompleteIdentity("client", args.client.name);
  const projectClientMatch = args.project?.clientName ? matchByName(clientsResult.rows, args.project.clientName) : undefined;
  if (args.project?.clientName && projectClientMatch?.kind === "many") return safeAmbiguous("client", args.project.clientName, projectClientMatch.matches);
  if (args.project?.clientName && clientsResult.truncated) return safeIncompleteIdentity("client", args.project.clientName);
  const clientWillBeCreated = Boolean(
    args.project?.clientName && args.client &&
    normalizeName(args.project.clientName) === normalizeName(args.client.name) &&
    clientMatch?.kind === "none",
  );
  if (args.project?.clientName && projectClientMatch?.kind === "none" && !clientWillBeCreated) {
    const options = suggestOptions(clientsResult.rows, args.project.clientName);
    return {
      kind: "clarify",
      clarify: options.length
        ? `I couldn't find an active client named "${args.project.clientName}". Did you mean one of these, or should I create it?`
        : `I couldn't find an active client named "${args.project.clientName}". Should I create it?`,
      ...(options.length ? { options } : {}),
    };
  }
  const existingClientId = projectClientMatch?.kind === "one"
    ? projectClientMatch.entity.id
    : clientMatch?.kind === "one"
      ? clientMatch.entity.id
      : undefined;
  const projectCandidates = args.client && clientMatch?.kind === "none"
    ? []
    : existingClientId
      ? projectsResult.rows.filter((project) => project.clientId === existingClientId)
      : projectsResult.rows;
  const projectMatch = args.project ? matchByName(projectCandidates, args.project.name) : undefined;
  if (args.project && projectMatch?.kind === "many") return safeAmbiguous("project", args.project.name, projectMatch.matches);
  if (args.project && projectsResult.truncated) return safeIncompleteIdentity("project", args.project.name);
  const tasksResult = args.task && projectMatch?.kind === "one"
    ? await ctx.clockify.listTasks(projectMatch.entity.id)
    : undefined;
  const taskMatch = args.task && tasksResult ? matchByName(tasksResult.rows, args.task.name) : undefined;
  if (args.task && taskMatch?.kind === "many") return safeAmbiguous("task", args.task.name, taskMatch.matches);
  if (args.task && tasksResult?.truncated) return safeIncompleteIdentity("task", args.task.name);

  const targetSnapshots: TargetSnapshot[] = [];
  if (tagMatch?.kind === "one") {
    const projection = await ctx.clockify.prepareTagUpdate(tagMatch.entity.id, {});
    targetSnapshots.push(captureTargetSnapshot("target", { type: "tag", id: tagMatch.entity.id, name: tagMatch.entity.name }, projection));
  }
  const authoritativeClient = projectClientMatch?.kind === "one" ? projectClientMatch.entity : clientMatch?.kind === "one" ? clientMatch.entity : undefined;
  if (authoritativeClient) {
    const projection = await ctx.clockify.getClientMutationState(authoritativeClient.id);
    if (!projection) return { kind: "clarify", clarify: "The selected client could not be verified. Refresh and try again." };
    targetSnapshots.push(captureTargetSnapshot("parent", { type: "client", id: authoritativeClient.id, name: authoritativeClient.name }, projection));
  }
  if (projectMatch?.kind === "one") {
    const projection = await ctx.clockify.getProjectMutationState(projectMatch.entity.id);
    if (!projection) return { kind: "clarify", clarify: "The selected project could not be verified. Refresh and try again." };
    targetSnapshots.push(captureTargetSnapshot("parent", { type: "project", id: projectMatch.entity.id, name: projectMatch.entity.name }, projection));
  }
  if (taskMatch?.kind === "one" && projectMatch?.kind === "one") {
    const projection = await ctx.clockify.prepareTaskUpdate(projectMatch.entity.id, taskMatch.entity.id, {});
    targetSnapshots.push(captureTargetSnapshot("target", { type: "task", id: taskMatch.entity.id, name: taskMatch.entity.name, projectId: projectMatch.entity.id }, projection));
  }

  const operation: WorkPackageOperation = {
    ...(args.tag ? { tag: { name: args.tag.name, ...(tagMatch?.kind === "one" ? { existing: { id: tagMatch.entity.id, name: tagMatch.entity.name } } : {}) } } : {}),
    ...(args.client ? { client: { name: args.client.name, ...(clientMatch?.kind === "one" ? { existing: { id: clientMatch.entity.id, name: clientMatch.entity.name } } : {}) } } : {}),
    ...(args.project ? { project: {
      name: args.project.name,
      ...(projectMatch?.kind === "one" ? { existing: { id: projectMatch.entity.id, name: projectMatch.entity.name } } : {}),
      ...(existingClientId ? { existingClientId } : {}),
      clientFromStep: clientWillBeCreated,
    } } : {}),
    ...(args.task ? { task: {
      name: args.task.name,
      ...(taskMatch?.kind === "one" && projectMatch?.kind === "one"
        ? { existing: { id: taskMatch.entity.id, name: taskMatch.entity.name, projectId: projectMatch.entity.id } }
        : {}),
      projectFromStep: projectMatch?.kind !== "one",
    } } : {}),
    ...(args.startTimer && canWrite(ctx.policy, "time_tracking")
      ? { timer: { ...(typeof args.startTimer === "object" ? args.startTimer : {}), start: nowIso(ctx) } }
      : {}),
    timerDenied: Boolean(args.startTimer && !canWrite(ctx.policy, "time_tracking")),
    targetSnapshots,
  };
  const planSteps: Parameters<typeof dynamicMutationPlan>[0] = [];
  if (operation.tag && !operation.tag.existing) planSteps.push({ id: "create-tag", strategy: "create" });
  if (operation.client && !operation.client.existing) planSteps.push({ id: "create-client", strategy: "create" });
  if (operation.project && !operation.project.existing) planSteps.push({ id: "create-project", strategy: "create", ...(snapshotFingerprint(targetSnapshots, "client") ? { targetFingerprint: snapshotFingerprint(targetSnapshots, "client") } : {}) });
  if (operation.task && !operation.task.existing) planSteps.push({ id: "create-task", strategy: "create", ...(snapshotFingerprint(targetSnapshots, "project") ? { targetFingerprint: snapshotFingerprint(targetSnapshots, "project") } : {}) });
  if (operation.timer) planSteps.push({ id: "start-timer", strategy: "create", ...(snapshotFingerprint(targetSnapshots, "project") ? { targetFingerprint: snapshotFingerprint(targetSnapshots, "project") } : {}) });
  if (planSteps.length === 0) {
    const reused: EntityRef[] = [];
    if (operation.tag?.existing) reused.push({ type: "tag", ...operation.tag.existing });
    if (operation.client?.existing) reused.push({ type: "client", ...operation.client.existing });
    if (operation.project?.existing) reused.push({ type: "project", ...operation.project.existing });
    if (operation.task?.existing) reused.push({ type: "task", ...operation.task.existing });
    return {
      kind: "noop",
      receipt: successReceipt({
        action: "clockify_create_work_package",
        entity: "work_package",
        ids: { workspaceId: ctx.workspaceId },
        changed: { created: [], reused },
        warnings: operation.timerDenied
          ? [{ code: "policy_denied", message: "Timer not started: write access to time_tracking is disabled in your assistant permissions." }]
          : [],
      }),
    };
  }
  return { operation, mutationPlan: dynamicMutationPlan(planSteps) };
}

async function executeWorkPackage(ctx: ActionContext, prepared: BoundedPreparedSafeWrite): Promise<CommitResult> {
  const data = prepared.operation as WorkPackageOperation;
  const operation: ConfirmableOperation = {
    operationId: ctx.mutationJournal?.operationId ?? "direct:clockify_create_work_package",
    actionName: "clockify_create_work_package",
    featureGroup: "work_structure",
    risks: ["safe_write"],
    payload: data as unknown as Record<string, unknown>,
    mutationPlan: prepared.mutationPlan,
    targetSnapshots: data.targetSnapshots,
  };
  const created: EntityRef[] = [];
  const reused: EntityRef[] = [];
  const warnings: Array<{ code: string; message: string }> = [];
  let clientId = data.client?.existing?.id ?? data.project?.existingClientId;
  let projectId = data.project?.existing?.id;
  let taskId = data.task?.existing?.id;
  if (data.tag?.existing) reused.push({ type: "tag", ...data.tag.existing });
  if (data.client?.existing) reused.push({ type: "client", ...data.client.existing });
  if (data.project?.existing) reused.push({ type: "project", ...data.project.existing });
  if (data.task?.existing) reused.push({ type: "task", ...data.task.existing });
  if (data.timerDenied) warnings.push({ code: "policy_denied", message: "Timer not started: write access to time_tracking is disabled in your assistant permissions." });

  const verifyAll = async (): Promise<void> => {
    if (data.targetSnapshots.length === 0) return;
    const verified = await verifyTargetSnapshots(data.targetSnapshots, (snapshot) => fetchCompositeSnapshot(ctx, snapshot));
    if (!verified.ok) throw new DefinitiveWriteFailure("VERIFY", verified.code, verified.message);
  };
  try {
    await verifyAll();
  } catch (error) {
    const message = error instanceof Error ? error.message : "A reused work-package target changed before dispatch.";
    return errorReceipt({
      action: operation.actionName,
      code: "stale_parent",
      message,
      recovery: { hint: "Refresh the request and create a new preview.", retryable: true },
    });
  }
  let planIndex = 0;
  const fail = (step: Awaited<ReturnType<typeof executeDurableRiskyStep>>, label: string): CommitResult | undefined => {
    if (step.status === "succeeded") return undefined;
    const message = step.status === "outcome_unknown"
      ? `The ${label} outcome is unknown; no later work-package mutation was sent.`
      : `Clockify rejected the ${label}; no later work-package mutation was sent.`;
    if (created.length > 0) return workPackagePartial(ctx, created, reused, warnings, message);
    return errorReceipt({
      action: operation.actionName,
      code: step.status === "outcome_unknown" ? "commit_outcome_unknown" : "write_failed",
      message,
      recovery: { hint: "Inspect Clockify before previewing only the unfinished changes.", retryable: false },
    });
  };
  const executeCreate = async <T extends { id: string; name?: string }>(input: {
    id: string;
    label: string;
    beforeIds: string[];
    expected: Record<string, unknown>;
    dispatch(): Promise<T>;
    reconcile(): Promise<T | undefined>;
    ref(value: T): EntityRef;
  }): Promise<{ value?: T; result?: CommitResult }> => {
    let value: T | undefined;
    const step = await executeDurableRiskyStep({
      ctx, operation, planStepId: input.id, index: planIndex++, name: input.label,
      preparedDetail: { beforeIds: input.beforeIds, expected: input.expected },
      dispatch: async () => {
        const dispatched = await dispatchWithReconciliation({
          dispatch: async () => requireCreated(await input.dispatch(), input.label),
          reconcile: () => input.reconcile(),
        });
        value = dispatched.value;
        const ref = input.ref(dispatched.value);
        return { externalId: dispatched.value.id, effect: { created: ref }, detail: { reconciled: dispatched.reconciled } };
      },
    });
    const result = fail(step, input.label);
    if (!result && value) created.push(input.ref(value));
    return { value, ...(result ? { result } : {}) };
  };

  if (data.tag && !data.tag.existing) {
    const baseline = completeAbsentBaseline(await ctx.clockify.listTags({ archived: false }), "tag", data.tag.name);
    if (!baseline.ok) return initialOrPartialFailure(ctx, created, reused, warnings, operation.actionName, baseline.message);
    const outcome = await executeCreate({
      id: "create-tag", label: "tag create", beforeIds: baseline.ids,
      expected: { name: data.tag.name },
      dispatch: () => ctx.clockify.createTag({ name: data.tag!.name }),
      reconcile: () => reconcileCreate({ beforeIds: baseline.ids, list: () => ctx.clockify.listTags({ archived: false }), matches: (row) => normalizeName(row.name) === normalizeName(data.tag!.name) }),
      ref: (row) => ({ type: "tag", id: row.id, name: row.name }),
    });
    if (outcome.result) return outcome.result;
  }
  if (data.client && !data.client.existing) {
    const baseline = completeAbsentBaseline(await ctx.clockify.listClients({ archived: false }), "client", data.client.name);
    if (!baseline.ok) return initialOrPartialFailure(ctx, created, reused, warnings, operation.actionName, baseline.message);
    const outcome = await executeCreate({
      id: "create-client", label: "client create", beforeIds: baseline.ids,
      expected: { name: data.client.name },
      dispatch: () => ctx.clockify.createClientBaseAtomic({ name: data.client!.name }),
      reconcile: () => reconcileCreate({ beforeIds: baseline.ids, list: () => ctx.clockify.listClients({ archived: false }), matches: (row) => normalizeName(row.name) === normalizeName(data.client!.name) }),
      ref: (row) => ({ type: "client", id: row.id, name: row.name }),
    });
    if (outcome.result) return outcome.result;
    clientId = outcome.value?.id;
  }
  if (data.project && !data.project.existing) {
    if (data.project.existingClientId) await verifyAll();
    const baselineList = await ctx.clockify.listProjects({ archived: false, ...(clientId ? { clientIds: [clientId] } : {}) });
    const baseline = completeAbsentBaseline(baselineList, "project", data.project.name);
    if (!baseline.ok) return initialOrPartialFailure(ctx, created, reused, warnings, operation.actionName, baseline.message);
    const outcome = await executeCreate({
      id: "create-project", label: "project create", beforeIds: baseline.ids,
      expected: { name: data.project.name, ...(clientId ? { clientId } : {}) },
      dispatch: () => ctx.clockify.createProjectAtomic({ name: data.project!.name, ...(clientId ? { clientId } : {}) }),
      reconcile: () => reconcileCreate({
        beforeIds: baseline.ids,
        list: () => ctx.clockify.listProjects({ archived: false, ...(clientId ? { clientIds: [clientId] } : {}) }),
        matches: (row) => normalizeName(row.name) === normalizeName(data.project!.name) && (clientId === undefined || row.clientId === clientId),
      }),
      ref: (row) => ({ type: "project", id: row.id, name: row.name }),
    });
    if (outcome.result) return outcome.result;
    projectId = outcome.value?.id;
  }
  if (data.task && !data.task.existing) {
    if (!projectId) return initialOrPartialFailure(ctx, created, reused, warnings, operation.actionName, "The task parent project could not be resolved. No task was created.");
    if (!data.task.projectFromStep) await verifyAll();
    const baseline = completeAbsentBaseline(await ctx.clockify.listTasks(projectId), "task", data.task.name);
    if (!baseline.ok) return initialOrPartialFailure(ctx, created, reused, warnings, operation.actionName, baseline.message);
    const outcome = await executeCreate({
      id: "create-task", label: "task create", beforeIds: baseline.ids,
      expected: { projectId, name: data.task.name },
      dispatch: () => ctx.clockify.createTaskAtomic({ projectId: projectId!, name: data.task!.name }),
      reconcile: () => reconcileCreate({ beforeIds: baseline.ids, list: () => ctx.clockify.listTasks(projectId!), matches: (row) => normalizeName(row.name) === normalizeName(data.task!.name) }),
      ref: (row) => ({ type: "task", id: row.id, name: row.name, projectId: projectId! }),
    });
    if (outcome.result) return outcome.result;
    taskId = outcome.value?.id;
  }
  if (data.timer) {
    if (!projectId) return initialOrPartialFailure(ctx, created, reused, warnings, operation.actionName, "The timer parent project could not be resolved. No timer was started.");
    if (data.project?.existing || data.task?.existing) await verifyAll();
    const beforeRunning = await ctx.clockify.getRunningTimeEntry(ctx.adminUserId);
    const input = {
      userId: ctx.adminUserId,
      ...(data.timer.description !== undefined ? { description: data.timer.description } : {}),
      projectId,
      ...(taskId ? { taskId } : {}),
      ...(data.timer.billable !== undefined ? { billable: data.timer.billable } : {}),
      start: data.timer.start,
    };
    let entry: Awaited<ReturnType<ActionContext["clockify"]["startTimeEntryAtomic"]>> | undefined;
    const step = await executeDurableRiskyStep({
      ctx, operation, planStepId: "start-timer", index: planIndex++, name: "Start timer",
      preparedDetail: { ...(beforeRunning ? { priorRunningId: beforeRunning.id } : {}), input },
      dispatch: async () => {
        const dispatched = await dispatchWithReconciliation({
          dispatch: async () => requireCreated(await ctx.clockify.startTimeEntryAtomic(input), "timer start"),
          reconcile: async () => {
            const running = await ctx.clockify.getRunningTimeEntry(ctx.adminUserId);
            return running && running.id !== beforeRunning?.id && timerMatches(running, input) ? running : undefined;
          },
        });
        entry = dispatched.value;
        return {
          externalId: entry.id,
          effect: { created: { type: "time_entry", id: entry.id, ...(entry.description ? { name: entry.description } : {}) } },
          detail: { reconciled: dispatched.reconciled },
        };
      },
    });
    const result = fail(step, "timer start");
    if (result) return result;
    if (entry) created.push({ type: "time_entry", id: entry.id, ...(entry.description ? { name: entry.description } : {}) });
  }
  return successReceipt({
    action: operation.actionName,
    entity: "work_package",
    ids: { workspaceId: ctx.workspaceId },
    changed: { created, reused },
    warnings,
  });
}

function safeAmbiguous(type: string, name: string, matches: Array<{ id: string; name: string }>): SafeWritePreparationResult {
  return { kind: "clarify", clarify: `Several ${type}s are named "${name}". Which one?`, options: matches.map((row) => ({ id: row.id, label: row.name })) };
}

function safeIncompleteIdentity(type: string, name: string): SafeWritePreparationResult {
  return { kind: "clarify", clarify: `Clockify returned an incomplete ${type} list, so I can't prove "${name}" is unique or absent. Provide the exact id or use a narrower filter.` };
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function snapshotFingerprint(snapshots: readonly TargetSnapshot[], type: string): string | undefined {
  return snapshots.find((snapshot) => snapshot.ref.type === type)?.fingerprint;
}

function completeAbsentBaseline<T extends { id: string; name: string }>(
  list: ListResult<T>,
  type: string,
  name: string,
): { ok: true; ids: string[] } | { ok: false; message: string } {
  if (list.truncated) return { ok: false, message: `The complete ${type} baseline could not be established. No ${type} was created.` };
  if (list.rows.some((row) => normalizeName(row.name) === normalizeName(name))) {
    return { ok: false, message: `The ${type} baseline changed before dispatch. No duplicate ${type} was created.` };
  }
  return { ok: true, ids: list.rows.map((row) => row.id).sort() };
}

function requireCreated<T extends { id: string }>(value: T, label: string): T {
  if (!value || typeof value.id !== "string" || value.id.length === 0) {
    throw new AmbiguousWriteOutcome("POST", label, "Clockify returned a malformed create success without an id.");
  }
  return value;
}

function timerMatches(
  row: { projectId?: string; taskId?: string; description?: string; billable?: boolean; start?: string },
  input: { projectId: string; taskId?: string; description?: string; billable?: boolean; start: string },
): boolean {
  return row.projectId === input.projectId &&
    row.taskId === input.taskId &&
    row.description === input.description &&
    row.billable === input.billable &&
    row.start === input.start;
}

function initialOrPartialFailure(
  ctx: ActionContext,
  created: EntityRef[],
  reused: EntityRef[],
  warnings: Array<{ code: string; message: string }>,
  action: string,
  message: string,
): CommitResult {
  return created.length > 0
    ? workPackagePartial(ctx, created, reused, warnings, message)
    : errorReceipt({ action, code: "stale_parent", message, recovery: { hint: "Refresh the request and try again.", retryable: true } });
}

function workPackagePartial(
  ctx: ActionContext,
  created: EntityRef[],
  reused: EntityRef[],
  warnings: Array<{ code: string; message: string }>,
  message: string,
): Extract<CommitResult, { kind: "partial" }> {
  return {
    kind: "partial",
    receipt: successReceipt({
      action: "clockify_create_work_package",
      entity: "work_package",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created, reused },
      warnings,
    }),
    message,
    recovery: { hint: "Inspect the retained entities before previewing only the unfinished changes.", retryable: false },
  };
}

const createWorkPackage = defineAction({
  name: "clockify_create_work_package",
  description:
    "Create or reuse a client, project, task, and/or tag by name in one step. Set `startTimer` to also start a timer on the created/reused project in the same step — use this for \"create a project and start a timer on it\" so the new project id is resolved server-side (do not emit a separate start-timer that references an id that does not exist yet).",
  featureGroup: "work_structure",
  risks: ["safe_write"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({
    source: "safe",
    targeting: { mode: "snapshots", relations: ["target", "parent"] },
    strategies: ["create"],
  }),
  argumentAliases: ["tagName", "projectName", "taskName"],
  schema: z.preprocess(
    normalizeWorkPackageArgs,
    z
      .object({
        tag: z.object({ name: z.string().min(1) }).optional(),
        client: z.object({ name: z.string().min(1) }).optional(),
        project: z
          .object({ name: z.string().min(1), clientName: z.string().optional() })
          .optional(),
        task: z.object({ name: z.string().min(1) }).optional(),
        // Accept either a bare `true` (the planner's natural shape) or an options
        // object. `false`/absent means do not start a timer.
        startTimer: z
          .union([
            z.boolean(),
            z.object({
              description: z.string().optional(),
              billable: z.boolean().optional(),
            }),
          ])
          .optional(),
      })
      .refine((value) => value.tag || value.client || value.project || value.task, {
        message: "Provide at least one of tag, client, project, or task.",
      }),
  ),
  prepareSafeWrite: prepareWorkPackage,
  executeSafeWrite: executeWorkPackage,
});

const listEntities = defineAction({
  name: "clockify_list_entities",
  description:
    "List entities of a given type (tag, project, client, task, user, expense, webhook). Tasks require a projectId.",
  featureGroup: "work_structure",
  risks: ["read"],
  schema: z.object({
    entityType: z.enum(LISTABLE_ENTITY_TYPES),
    projectId: z.string().optional(),
  }),
  resolveFeatureGroup: (args) => LIST_ENTITY_GROUP[args.entityType],
  async handler(ctx, args) {
    if (args.entityType === "task" && !args.projectId) {
      return {
        kind: "clarify",
        message: "To list tasks I need a project. Which project's tasks should I list?",
      };
    }
    const { rows, truncated } = await listByType(ctx, args.entityType, args.projectId);
    return {
      kind: "receipt",
      receipt: listReceipt({
        action: "clockify_list_entities",
        entity: args.entityType,
        ids: { workspaceId: ctx.workspaceId },
        rows,
        truncated,
        data: { entityType: args.entityType },
      }),
    };
  },
});

const getEntity = defineAction({
  name: "clockify_get_entity",
  description:
    "Fetch a single entity by id (tag, project, client, task, user, expense, webhook). Tasks require a projectId.",
  featureGroup: "work_structure",
  risks: ["read"],
  schema: z.object({
    entityType: z.enum(LISTABLE_ENTITY_TYPES),
    id: z.string().min(1),
    projectId: z.string().optional(),
  }),
  resolveFeatureGroup: (args) => LIST_ENTITY_GROUP[args.entityType],
  async handler(ctx, args) {
    if (args.entityType === "task" && !args.projectId) {
      return {
        kind: "clarify",
        message: "To fetch a task I need its project. Which project is it in?",
      };
    }
    // Typed per-type GET (resolves archived/off-active-list ids too); a missing id
    // still yields the `entity: null` receipt shape, never a throw.
    const entity = await getByType(ctx, args.entityType, args.id, args.projectId);
    if (entity === undefined) {
      return {
        kind: "clarify",
        message: `Clockify returned an incomplete ${args.entityType} list, so I can't verify that id ${args.id} is absent. Use a narrower filter and try again.`,
      };
    }
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_get_entity",
        entity: args.entityType,
        ids: { workspaceId: ctx.workspaceId },
        data: { entityType: args.entityType, entity },
      }),
    };
  },
});

export const WORK_STRUCTURE_ACTIONS: ActionDefinition[] = [
  createWorkPackage,
  listEntities,
  getEntity,
];
