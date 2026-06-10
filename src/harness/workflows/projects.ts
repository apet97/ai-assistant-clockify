import { z } from "zod";
import {
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionDefinition,
} from "../action.js";
import { successReceipt } from "../receipts.js";
import { resolveEntityRef } from "./resolve.js";

/**
 * Typed project workflows (goclmcp §2.2) — the worked reference area. Reads and
 * safe creates execute immediately; updates/archive/delete/rate/estimate/
 * memberships are risky and return a preview + a stored operation, mutating only
 * in `commit` after a button confirmation. The REST layer does I/O; all risk and
 * policy logic lives here and in the executor.
 */

const PROJECT_GROUP = "work_structure" as const;

// ── Reads ────────────────────────────────────────────────────────────────────

const listProjects = defineReadAction({
  name: "clockify_projects_list",
  description: "List projects, optionally filtered by name, archived state, or client ids.",
  group: PROJECT_GROUP,
  schema: z.object({
    name: z.string().optional(),
    archived: z.boolean().optional(),
    clientIds: z.array(z.string()).optional(),
  }),
  async handler(ctx, args) {
    const items = await ctx.clockify.listProjects(args);
    return successReceipt({
      action: "clockify_projects_list",
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      data: { count: items.length, items },
    });
  },
});

const getProject = defineAction({
  name: "clockify_projects_get",
  description: "Fetch a single project by id, or by its exact `name` (resolved server-side).",
  featureGroup: PROJECT_GROUP,
  risks: ["read"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the project id or its exact name.",
    }),
  async handler(ctx, args) {
    const resolved = await resolveEntityRef(args, {
      noun: "project",
      verb: "fetch",
      list: () => ctx.clockify.listProjects(),
    });
    if (!resolved.ok) {
      return { kind: "clarify", message: resolved.clarify.clarify, options: resolved.clarify.options };
    }
    const entity = await ctx.clockify.getProject(resolved.id);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_projects_get",
        entity: "project",
        ids: { workspaceId: ctx.workspaceId },
        data: { entity },
      }),
    };
  },
});

// ── Safe writes ──────────────────────────────────────────────────────────────

const createProject = defineAction({
  name: "clockify_projects_create",
  description: "Create a project. Safe write — executes immediately when policy allows.",
  featureGroup: PROJECT_GROUP,
  risks: ["safe_write"],
  schema: z.object({
    name: z.string().min(1),
    clientId: z.string().optional(),
    billable: z.boolean().optional(),
    color: z.string().optional(), // hex
    isPublic: z.boolean().optional(),
  }),
  async handler(ctx, args) {
    const project = await ctx.clockify.createProject(args);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_projects_create",
        entity: "project",
        ids: { workspaceId: ctx.workspaceId },
        changed: { created: [{ type: "project", id: project.id, name: project.name }] },
      }),
    };
  },
});

const createFromTemplate = defineAction({
  name: "clockify_projects_from_template",
  description: "Create a project from an existing project template.",
  featureGroup: PROJECT_GROUP,
  risks: ["safe_write"],
  schema: z.object({ templateId: z.string().min(1), name: z.string().optional() }),
  async handler(ctx, args) {
    const project = await ctx.clockify.createProjectFromTemplate(args);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_projects_from_template",
        entity: "project",
        ids: { workspaceId: ctx.workspaceId },
        changed: { created: [{ type: "project", id: project.id, name: project.name }] },
      }),
    };
  },
});

// ── Risky writes (preview → commit) ──────────────────────────────────────────

const updateProject = defineRiskyAction({
  name: "clockify_projects_update",
  description:
    "Update a project's fields (rename, reassign client, billing, color, visibility). Pass the project's `id`, or its exact `currentName` and the harness resolves it — use this to RENAME (`currentName` + the new `name`) without listing first. Elevated write — previews and requires confirmation.",
  group: PROJECT_GROUP,
  risks: ["high_risk_write"],
  schema: z
    .object({
      id: z.string().min(1).optional(),
      /** The project's existing name, resolved to an id server-side (rename-by-name). */
      currentName: z.string().min(1).optional(),
      name: z.string().optional(),
      clientId: z.string().optional(),
      billable: z.boolean().optional(),
      color: z.string().optional(),
      isPublic: z.boolean().optional(),
      archived: z.boolean().optional(),
    })
    .refine((v) => v.id !== undefined || v.currentName !== undefined, {
      message: "Provide the project id or its exact currentName.",
    })
    .refine(
      (v) =>
        v.name !== undefined ||
        v.clientId !== undefined ||
        v.billable !== undefined ||
        v.color !== undefined ||
        v.isPublic !== undefined ||
        v.archived !== undefined,
      { message: "Provide at least one field to change." },
    ),
  async preview(ctx, args) {
    const resolved = await resolveEntityRef(
      { id: args.id, name: args.currentName },
      { noun: "project", verb: "update", list: () => ctx.clockify.listProjects() },
    );
    if (!resolved.ok) return resolved.clarify;
    const { id: _id, currentName: _currentName, ...patch } = args;
    const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    return {
      actionLabel: "Update project",
      targets: [{ type: "project", id: resolved.id, name: resolved.name ?? args.name }],
      expectedChanges: Object.keys(fields).map((key) => `set ${key}`),
      reversibility: "You can update the project again to revert most fields.",
      warnings: ["Updating a project changes live workspace data."],
      payload: { id: resolved.id, patch: fields },
    };
  },
  async commit(ctx, payload) {
    const { id, patch } = payload as { id: string; patch: Record<string, unknown> };
    const updated = await ctx.clockify.updateProject(id, patch);
    return successReceipt({
      action: "clockify_projects_update",
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "project", id: updated.id, name: updated.name }] },
    });
  },
});

const archiveProject = defineRiskyAction({
  name: "clockify_projects_archive",
  description:
    "Archive a project (hides it from active lists). Pass the project id, or its exact `name` and the harness resolves it. Previews and requires confirmation.",
  group: PROJECT_GROUP,
  risks: ["destructive"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the project id or its exact name.",
    }),
  async preview(ctx, args) {
    const resolved = await resolveEntityRef(args, {
      noun: "project",
      verb: "archive",
      list: () => ctx.clockify.listProjects(),
    });
    if (!resolved.ok) return resolved.clarify;
    const name = resolved.name ?? args.name;
    return {
      actionLabel: "Archive project",
      targets: [{ type: "project", id: resolved.id, name }],
      expectedChanges: [`Archive project ${name ?? resolved.id}`],
      reversibility: "Archiving is reversible — you can unarchive the project later.",
      warnings: ["Archiving hides the project from active workflows."],
      payload: { id: resolved.id, name },
    };
  },
  async commit(ctx, payload) {
    const { id } = payload as { id: string };
    const archived = await ctx.clockify.archiveProject(id);
    return successReceipt({
      action: "clockify_projects_archive",
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "project", id: archived.id, name: archived.name }] },
    });
  },
});

const deleteProject = defineRiskyAction({
  name: "clockify_projects_delete",
  description:
    "Delete a project (archives first, then deletes — Clockify rejects deleting an active project). Pass the project id (preferred — list projects first to get it), or its exact name and the harness resolves it. Previews and requires confirmation.",
  group: PROJECT_GROUP,
  risks: ["destructive"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the project id or its exact name.",
    }),
  async preview(ctx, args) {
    // Resolve a name → id (including a name passed in the id slot), so a delete
    // never dead-ends or commits a doomed id. Ambiguous identity stops and asks.
    const resolved = await resolveEntityRef(args, {
      noun: "project",
      verb: "delete",
      list: () => ctx.clockify.listProjects(),
    });
    if (!resolved.ok) return resolved.clarify;
    const { id } = resolved;
    const name = resolved.name ?? args.name;
    return {
      actionLabel: "Delete project",
      targets: [{ type: "project", id, name }],
      expectedChanges: [`Delete project ${name ?? id} (and its tasks)`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting a project is permanent and removes its tasks."],
      payload: { id, name },
    };
  },
  async commit(ctx, payload) {
    const { id, name } = payload as { id: string; name?: string };
    await ctx.clockify.deleteProject(id);
    return successReceipt({
      action: "clockify_projects_delete",
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "project", id, name }] },
    });
  },
});

const rateUpdate = defineRiskyAction({
  name: "clockify_projects_rate_update",
  description:
    "Set a project member's billable hourly or cost rate. Billing action — previews and requires confirmation.",
  group: "invoices",
  risks: ["billing"],
  schema: z.object({
    projectId: z.string().min(1),
    userId: z.string().min(1),
    rateKind: z.enum(["HOURLY", "COST"]),
    amount: z.number().nonnegative(),
    /** `major` (e.g. 75.00) is converted ×100 to the minor units Clockify wants. */
    amountUnit: z.enum(["major", "minor"]).default("major"),
    since: z.string().optional(),
  }),
  async preview(_ctx, args) {
    const amountMinor = args.amountUnit === "minor" ? Math.round(args.amount) : Math.round(args.amount * 100);
    return {
      actionLabel: `Set project ${args.rateKind === "COST" ? "cost" : "hourly"} rate`,
      targets: [{ type: "project", id: args.projectId }],
      expectedChanges: [
        `Set ${args.rateKind} rate for user ${args.userId} to ${amountMinor} (minor units)`,
      ],
      reversibility: "You can set a new rate at any time; past entries keep their recorded rate.",
      warnings: ["This changes the billable amount of future entries."],
      payload: {
        projectId: args.projectId,
        userId: args.userId,
        rateKind: args.rateKind,
        amountMinor,
        since: args.since,
      },
    };
  },
  async commit(ctx, payload) {
    const operation = payload as {
      projectId: string;
      userId: string;
      rateKind: "HOURLY" | "COST";
      amountMinor: number;
      since?: string;
    };
    await ctx.clockify.updateProjectRate(operation);
    return successReceipt({
      action: "clockify_projects_rate_update",
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "project", id: operation.projectId }] },
    });
  },
});

const estimateUpdate = defineRiskyAction({
  name: "clockify_projects_estimate_update",
  description:
    "Update a project's time/budget estimate. Elevated write — previews and requires confirmation.",
  group: PROJECT_GROUP,
  risks: ["high_risk_write"],
  schema: z.object({
    id: z.string().min(1),
    fields: z.record(z.string(), z.unknown()).refine((f) => Object.keys(f).length > 0, {
      message: "Provide at least one estimate field.",
    }),
  }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Update project estimate",
      targets: [{ type: "project", id: args.id }],
      expectedChanges: Object.keys(args.fields).map((key) => `set estimate ${key}`),
      reversibility: "You can update the estimate again at any time.",
      warnings: ["Changing the estimate affects progress and budget reporting."],
      payload: { id: args.id, fields: args.fields },
    };
  },
  async commit(ctx, payload) {
    const { id, fields } = payload as { id: string; fields: Record<string, unknown> };
    await ctx.clockify.updateProjectEstimate(id, fields);
    return successReceipt({
      action: "clockify_projects_estimate_update",
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "project", id }] },
    });
  },
});

const membershipsUpdate = defineRiskyAction({
  name: "clockify_projects_memberships_update",
  description:
    "Replace a project's membership set (who can access/track it). Elevated write — previews and requires confirmation.",
  group: "users_groups",
  // NOTE: this is a real Clockify write, so it must be gated by the `users_groups`
  // feature-group policy. The `permission_change` label is reserved for the
  // assistant's OWN policy management (`assistant_update_permissions`), which the
  // executor intentionally exempts from the Clockify feature-group gate; using it
  // here would BYPASS that gate. `high_risk_write` keeps confirmation AND the gate.
  risks: ["high_risk_write"],
  schema: z.object({
    id: z.string().min(1),
    memberships: z.array(z.record(z.string(), z.unknown())).min(1),
  }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Update project memberships",
      targets: [{ type: "project", id: args.id }],
      expectedChanges: [`Replace membership set (${args.memberships.length} member(s))`],
      reversibility: "You can update memberships again to restore prior access.",
      warnings: ["This replaces who can access and track time on the project."],
      payload: { id: args.id, memberships: args.memberships },
    };
  },
  async commit(ctx, payload) {
    const { id, memberships } = payload as {
      id: string;
      memberships: Array<Record<string, unknown>>;
    };
    await ctx.clockify.updateProjectMemberships(id, { memberships });
    return successReceipt({
      action: "clockify_projects_memberships_update",
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "project", id }] },
    });
  },
});

export const PROJECT_ACTIONS: ActionDefinition[] = [
  listProjects,
  getProject,
  createProject,
  createFromTemplate,
  updateProject,
  archiveProject,
  deleteProject,
  rateUpdate,
  estimateUpdate,
  membershipsUpdate,
];
