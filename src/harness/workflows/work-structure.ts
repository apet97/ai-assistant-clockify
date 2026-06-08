import { z } from "zod";
import { defineAction, type ActionContext, type ActionDefinition, type ActionResult } from "../action.js";
import type { EntitySummary } from "../../clockify/client.js";
import { canWrite, type FeatureGroup } from "../permissions.js";
import type { EntityRef, Warning } from "../receipts.js";
import { successReceipt } from "../receipts.js";
import { matchByName } from "./resolve.js";

function nowIso(ctx: ActionContext): string {
  return (ctx.now ?? (() => new Date()))().toISOString();
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

const createWorkPackage = defineAction({
  name: "clockify_create_work_package",
  description:
    "Create or reuse a client, project, task, and/or tag by name in one step. Set `startTimer` to also start a timer on the created/reused project in the same step — use this for \"create a project and start a timer on it\" so the new project id is resolved server-side (do not emit a separate start-timer that references an id that does not exist yet).",
  featureGroup: "work_structure",
  risks: ["safe_write"],
  schema: z
    .object({
      tag: z.object({ name: z.string().min(1) }).optional(),
      client: z.object({ name: z.string().min(1) }).optional(),
      project: z
        .object({ name: z.string().min(1), clientName: z.string().optional() })
        .optional(),
      task: z.object({ name: z.string().min(1) }).optional(),
      startTimer: z
        .object({
          description: z.string().optional(),
          billable: z.boolean().optional(),
        })
        .optional(),
    })
    .refine((value) => value.tag || value.client || value.project || value.task, {
      message: "Provide at least one of tag, client, project, or task.",
    }),
  async handler(ctx, args) {
    const created: EntityRef[] = [];
    const reused: EntityRef[] = [];
    const warnings: Warning[] = [];

    if (args.tag) {
      const tags = await ctx.clockify.listTags();
      const match = matchByName(tags, args.tag.name);
      if (match.kind === "one") {
        reused.push({ type: "tag", id: match.entity.id, name: match.entity.name });
      } else if (match.kind === "many") {
        return ambiguous("tag", args.tag.name, match.matches);
      } else {
        const tag = await ctx.clockify.createTag({ name: args.tag.name });
        created.push({ type: "tag", id: tag.id, name: tag.name });
      }
    }

    let clientId: string | undefined;
    if (args.client) {
      const resolved = await resolveOrCreateClient(ctx, args.client.name, created, reused);
      if (resolved.kind === "clarify") return resolved.result;
      clientId = resolved.id;
    }

    let projectId: string | undefined;
    if (args.project) {
      if (args.project.clientName) {
        const resolved = await resolveExistingClient(ctx, args.project.clientName);
        if (resolved.kind === "clarify") return resolved.result;
        clientId = resolved.id;
      }
      const projects = await ctx.clockify.listProjects();
      const candidates = clientId ? projects.filter((p) => p.clientId === clientId) : projects;
      const match = matchByName(candidates, args.project.name);
      if (match.kind === "one") {
        projectId = match.entity.id;
        reused.push({ type: "project", id: match.entity.id, name: match.entity.name });
      } else if (match.kind === "many") {
        return ambiguous("project", args.project.name, match.matches);
      } else {
        const project = await ctx.clockify.createProject({ name: args.project.name, clientId });
        projectId = project.id;
        created.push({ type: "project", id: project.id, name: project.name });
      }
    }

    let taskId: string | undefined;
    if (args.task) {
      if (!projectId) {
        return {
          kind: "clarify",
          message: `To create task "${args.task.name}" I need a project. Which project should it belong to?`,
        };
      }
      const tasks = await ctx.clockify.listTasks(projectId);
      const match = matchByName(tasks, args.task.name);
      if (match.kind === "one") {
        taskId = match.entity.id;
        reused.push({ type: "task", id: match.entity.id, name: match.entity.name });
      } else if (match.kind === "many") {
        return ambiguous("task", args.task.name, match.matches);
      } else {
        const task = await ctx.clockify.createTask({ projectId, name: args.task.name });
        taskId = task.id;
        created.push({ type: "task", id: task.id, name: task.name });
      }
    }

    // Optionally start a timer on the just-created/reused project in the same step
    // (SPEC: "the harness decides, not the model" — the new project id is resolved
    // server-side, so the planner never has to reference an id that does not exist
    // yet). Starting a timer is a `time_tracking` write, so it is gated by that
    // group independently of this action's `work_structure` gate.
    if (args.startTimer) {
      if (!projectId) {
        return {
          kind: "clarify",
          message:
            "To start a timer I need a project. Add a project to create or reuse, or start the timer separately.",
        };
      }
      if (!canWrite(ctx.policy, "time_tracking")) {
        warnings.push({
          code: "policy_denied",
          message:
            "Timer not started: write access to time_tracking is disabled in your assistant permissions.",
        });
      } else {
        const entry = await ctx.clockify.startTimeEntry({
          userId: ctx.adminUserId,
          description: args.startTimer.description,
          projectId,
          taskId,
          billable: args.startTimer.billable,
          start: nowIso(ctx),
        });
        created.push({ type: "time_entry", id: entry.id, name: entry.description });
      }
    }

    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_create_work_package",
        entity: "work_package",
        ids: { workspaceId: ctx.workspaceId },
        changed: { created, reused },
        warnings,
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

async function resolveExistingClient(
  ctx: ActionContext,
  name: string,
): Promise<{ kind: "id"; id: string } | { kind: "clarify"; result: ActionResult }> {
  const clients = await ctx.clockify.listClients();
  const match = matchByName(clients, name);
  if (match.kind === "one") return { kind: "id", id: match.entity.id };
  if (match.kind === "many") {
    return { kind: "clarify", result: ambiguous("client", name, match.matches) };
  }
  return {
    kind: "clarify",
    result: {
      kind: "clarify",
      message: `I couldn't find an active client named "${name}". Should I create it, or which existing client did you mean?`,
    },
  };
}

async function resolveOrCreateClient(
  ctx: ActionContext,
  name: string,
  created: EntityRef[],
  reused: EntityRef[],
): Promise<{ kind: "id"; id: string } | { kind: "clarify"; result: ActionResult }> {
  const clients = await ctx.clockify.listClients();
  const match = matchByName(clients, name);
  if (match.kind === "one") {
    reused.push({ type: "client", id: match.entity.id, name: match.entity.name });
    return { kind: "id", id: match.entity.id };
  }
  if (match.kind === "many") {
    return { kind: "clarify", result: ambiguous("client", name, match.matches) };
  }
  const client = await ctx.clockify.createClient({ name });
  created.push({ type: "client", id: client.id, name: client.name });
  return { kind: "id", id: client.id };
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
    const items = await listByType(ctx, args.entityType, args.projectId);
    const entity = items.find((e) => e.id === args.id) ?? null;
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
