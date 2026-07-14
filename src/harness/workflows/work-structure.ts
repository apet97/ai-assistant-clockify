import { z } from "zod";
import { defineAction, type ActionContext, type ActionDefinition, type ActionResult } from "../action.js";
import type { EntitySummary } from "../../clockify/client.js";
import { canWrite, type FeatureGroup } from "../permissions.js";
import { successReceipt, errorReceipt } from "../receipts.js";
import { leftBehindNote, runComposition, type CompositionStep } from "../compose.js";
import { nowIso } from "../../durations.js";
import { matchByName, suggestOptions } from "./resolve.js";

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
): Promise<EntitySummary[]> {
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
): Promise<EntitySummary | null> {
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
      return (await ctx.clockify.listUsers()).find((e) => e.id === id) ?? null;
  }
}

const createWorkPackage = defineAction({
  name: "clockify_create_work_package",
  description:
    "Create or reuse a client, project, task, and/or tag by name in one step. Set `startTimer` to also start a timer on the created/reused project in the same step — use this for \"create a project and start a timer on it\" so the new project id is resolved server-side (do not emit a separate start-timer that references an id that does not exist yet).",
  featureGroup: "work_structure",
  risks: ["safe_write"],
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
  async handler(ctx, args) {
    // Resolve every dependency and ambiguity before the first write. A work
    // package must never create an early tag/client and only then discover that
    // a later task or timer has no parent, or that a reused name is ambiguous.
    if (args.task && !args.project) {
      return {
        kind: "clarify",
        message: `To create task "${args.task.name}" I need a project. Which project should it belong to?`,
      };
    }
    if (args.startTimer && !args.project) {
      return {
        kind: "clarify",
        message: "To start a timer I need a project. Add a project to create or reuse, or start the timer separately.",
      };
    }

    const [tags, clients, projects] = await Promise.all([
      args.tag ? ctx.clockify.listTags() : Promise.resolve([]),
      args.client || args.project?.clientName ? ctx.clockify.listClients() : Promise.resolve([]),
      args.project ? ctx.clockify.listProjects() : Promise.resolve([]),
    ]);
    const tagMatch = args.tag ? matchByName(tags, args.tag.name) : undefined;
    if (args.tag && tagMatch?.kind === "many") return ambiguous("tag", args.tag.name, tagMatch.matches);

    const clientMatch = args.client ? matchByName(clients, args.client.name) : undefined;
    if (args.client && clientMatch?.kind === "many") {
      return ambiguous("client", args.client.name, clientMatch.matches);
    }

    const projectClientMatch = args.project?.clientName
      ? matchByName(clients, args.project.clientName)
      : undefined;
    if (args.project?.clientName && projectClientMatch?.kind === "many") {
      return ambiguous("client", args.project.clientName, projectClientMatch.matches);
    }
    const projectClientWillBeCreated =
      args.project?.clientName !== undefined &&
      args.client !== undefined &&
      args.project.clientName.trim().toLowerCase() === args.client.name.trim().toLowerCase() &&
      clientMatch?.kind === "none";
    if (args.project?.clientName && projectClientMatch?.kind === "none" && !projectClientWillBeCreated) {
      const options = suggestOptions(clients, args.project.clientName);
      return {
        kind: "clarify",
        message: options.length
          ? `I couldn't find an active client named "${args.project.clientName}". Did you mean one of these, or should I create it?`
          : `I couldn't find an active client named "${args.project.clientName}". Should I create it?`,
        options: options.length ? options : undefined,
      };
    }

    const preflightClientId =
      projectClientMatch?.kind === "one"
        ? projectClientMatch.entity.id
        : clientMatch?.kind === "one"
          ? clientMatch.entity.id
          : undefined;
    const projectCandidates =
      args.client && clientMatch?.kind === "none"
        ? []
        : preflightClientId
          ? projects.filter((project) => project.clientId === preflightClientId)
          : projects;
    const projectMatch = args.project ? matchByName(projectCandidates, args.project.name) : undefined;
    if (args.project && projectMatch?.kind === "many") {
      return ambiguous("project", args.project.name, projectMatch.matches);
    }

    const taskMatch =
      args.task && projectMatch?.kind === "one"
        ? matchByName(await ctx.clockify.listTasks(projectMatch.entity.id), args.task.name)
        : undefined;
    if (args.task && taskMatch?.kind === "many") {
      return ambiguous("task", args.task.name, taskMatch.matches);
    }

    // Each entity is a composition STEP. A required step that fails rolls back the
    // entities this op already created (no orphan client/project when a later step
    // errors); the timer is best-effort (a failure warns, never rolls back).
    // Identity/dependency stops were handled above, before this list can mutate.
    const del = ctx.clockify.deleteEntity?.bind(ctx.clockify);
    // projectId is only needed (and only passed) for a `task` delete — it's
    // project-scoped on the wire; every other type ignores it.
    const undoFor = (entityType: string, id: string, projectId?: string): (() => Promise<void>) | undefined =>
      del ? () => del({ entityType, id, ...(projectId ? { projectId } : {}) }) : undefined;

    // Shared, forward-flowing ids (client → project → task → timer).
    const ids: { clientId?: string; projectId?: string; taskId?: string } = {};
    const steps: CompositionStep[] = [];

    if (args.tag) {
      const tag = args.tag;
      steps.push({
        label: "tag",
        required: true,
        run: async () => {
          const match = tagMatch!;
          if (match.kind === "one") return { kind: "done", reused: [{ type: "tag", id: match.entity.id, name: match.entity.name }] };
          const created = await ctx.clockify.createTag({ name: tag.name });
          return { kind: "done", created: [{ type: "tag", id: created.id, name: created.name }], undo: undoFor("tag", created.id) };
        },
      });
    }

    if (args.client) {
      const client = args.client;
      steps.push({
        label: "client",
        required: true,
        run: async () => {
          const match = clientMatch!;
          if (match.kind === "one") {
            ids.clientId = match.entity.id;
            return { kind: "done", reused: [{ type: "client", id: match.entity.id, name: match.entity.name }] };
          }
          const created = await ctx.clockify.createClient({ name: client.name });
          ids.clientId = created.id;
          return { kind: "done", created: [{ type: "client", id: created.id, name: created.name }], undo: undoFor("client", created.id) };
        },
      });
    }

    if (args.project) {
      const project = args.project;
      steps.push({
        label: "project",
        required: true,
        run: async () => {
          if (projectClientMatch?.kind === "one") {
            ids.clientId = projectClientMatch.entity.id;
          }
          const match = projectMatch!;
          if (match.kind === "one") {
            ids.projectId = match.entity.id;
            return { kind: "done", reused: [{ type: "project", id: match.entity.id, name: match.entity.name }] };
          }
          const created = await ctx.clockify.createProject({ name: project.name, clientId: ids.clientId });
          ids.projectId = created.id;
          return { kind: "done", created: [{ type: "project", id: created.id, name: created.name }], undo: undoFor("project", created.id) };
        },
      });
    }

    if (args.task) {
      const task = args.task;
      steps.push({
        label: "task",
        required: true,
        run: async () => {
          const match = taskMatch ?? { kind: "none" as const };
          if (match.kind === "one") {
            ids.taskId = match.entity.id;
            return { kind: "done", reused: [{ type: "task", id: match.entity.id, name: match.entity.name }] };
          }
          const projectId = ids.projectId!;
          const created = await ctx.clockify.createTask({ projectId, name: task.name });
          ids.taskId = created.id;
          return { kind: "done", created: [{ type: "task", id: created.id, name: created.name, projectId }], undo: undoFor("task", created.id, projectId) };
        },
      });
    }

    if (args.startTimer) {
      const timerOpts = typeof args.startTimer === "object" ? args.startTimer : {};
      steps.push({
        // Best-effort: a timer failure warns but never rolls back the work that was
        // successfully created. Starting a timer is a `time_tracking` write, gated
        // by that group independently of this action's `work_structure` gate.
        label: "timer",
        required: false,
        run: async () => {
          if (!canWrite(ctx.policy, "time_tracking")) {
            return {
              kind: "done",
              warnings: [
                {
                  code: "policy_denied",
                  message:
                    "Timer not started: write access to time_tracking is disabled in your assistant permissions.",
                },
              ],
            };
          }
          const entry = await ctx.clockify.startTimeEntry({
            userId: ctx.adminUserId,
            description: timerOpts.description,
            projectId: ids.projectId!,
            taskId: ids.taskId,
            billable: timerOpts.billable,
            start: nowIso(ctx),
          });
          return { kind: "done", created: [{ type: "time_entry", id: entry.id, name: entry.description }], undo: undoFor("time_entry", entry.id) };
        },
      });
    }

    const outcome = await runComposition(steps);
    if (outcome.status.kind === "stopped") {
      if (!outcome.status.retained && outcome.status.rollbackWarnings.length === 0) {
        return outcome.status.result;
      }
      const rolledBack = new Set(outcome.status.rolledBack.map((ref) => `${ref.type}:${ref.id}`));
      const remaining = outcome.created.filter((ref) => !rolledBack.has(`${ref.type}:${ref.id}`));
      const stopMessage = "message" in outcome.status.result
        ? outcome.status.result.message
        : "The workflow stopped before it could finish.";
      return {
        kind: "partial",
        receipt: successReceipt({
          action: "clockify_create_work_package",
          entity: "work_package",
          ids: { workspaceId: ctx.workspaceId },
          changed: { created: remaining, reused: outcome.reused },
          warnings: [...outcome.warnings, ...outcome.status.rollbackWarnings],
        }),
        message: `The request stopped part-way through. ${stopMessage}`,
        ...(outcome.status.result.kind === "clarify" && outcome.status.result.options
          ? { options: outcome.status.result.options }
          : {}),
        recovery: {
          hint: "Review the listed changes in Clockify before continuing or retrying.",
          retryable: false,
        },
      };
    }
    if (outcome.status.kind === "failed") {
      const rolled = outcome.status.rolledBack.length
        ? ` Rolled back: ${outcome.status.rolledBack.map((r) => `${r.type} ${r.name ?? r.id}`).join(", ")}.`
        : "";
      return {
        kind: "receipt",
        receipt: errorReceipt({
          action: "clockify_create_work_package",
          code: "composition_failed",
          message: `Couldn't complete the request: the ${outcome.status.label} step failed (${outcome.status.message}). ${leftBehindNote(outcome.status.rollbackWarnings)}${rolled}`,
          recovery: { hint: "Adjust the request and try again.", retryable: true },
        }),
      };
    }

    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_create_work_package",
        entity: "work_package",
        ids: { workspaceId: ctx.workspaceId },
        changed: { created: outcome.created, reused: outcome.reused },
        warnings: outcome.warnings,
      }),
    };
  },
});

function ambiguous(
  type: string,
  name: string,
  matches: Array<{ id: string; name: string }>,
): ActionResult {
  return {
    kind: "clarify",
    message: `Several ${type}s are named "${name}". Which one?`,
    options: matches.map((m) => ({ id: m.id, label: m.name })),
  };
}

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
    const items = await listByType(ctx, args.entityType, args.projectId);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_list_entities",
        entity: args.entityType,
        ids: { workspaceId: ctx.workspaceId },
        data: { entityType: args.entityType, count: items.length, items },
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
