import { z } from "zod";
import { defineAction, type ActionDefinition } from "../action.js";
import { successReceipt } from "../receipts.js";
import { matchByName, suggestOptions } from "./resolve.js";

/**
 * Typed project workflows (goclmcp §2.2) — the worked reference area. Reads and
 * safe creates execute immediately; updates/archive/delete/rate/estimate/
 * memberships are risky and return a preview + a stored operation, mutating only
 * in `commit` after a button confirmation. The REST layer does I/O; all risk and
 * policy logic lives here and in the executor.
 */

const PROJECT_GROUP = "work_structure" as const;

// ── Reads ────────────────────────────────────────────────────────────────────

const listProjects = defineAction({
  name: "clockify_projects_list",
  description: "List projects, optionally filtered by name, archived state, or client ids.",
  featureGroup: PROJECT_GROUP,
  risks: ["read"],
  schema: z.object({
    name: z.string().optional(),
    archived: z.boolean().optional(),
    clientIds: z.array(z.string()).optional(),
  }),
  async handler(ctx, args) {
    const items = await ctx.clockify.listProjects(args);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_projects_list",
        entity: "project",
        ids: { workspaceId: ctx.workspaceId },
        data: { count: items.length, items },
      }),
    };
  },
});

const getProject = defineAction({
  name: "clockify_projects_get",
  description: "Fetch a single project by id.",
  featureGroup: PROJECT_GROUP,
  risks: ["read"],
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getProject(args.id);
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

const updateProject = defineAction({
  name: "clockify_projects_update",
  description:
    "Update a project's fields (rename, reassign client, billing, color, visibility). Elevated write — previews and requires confirmation.",
  featureGroup: PROJECT_GROUP,
  risks: ["high_risk_write"],
  schema: z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
      clientId: z.string().optional(),
      billable: z.boolean().optional(),
      color: z.string().optional(),
      isPublic: z.boolean().optional(),
      archived: z.boolean().optional(),
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
  async handler(ctx, args) {
    const { id, ...patch } = args;
    const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    return {
      kind: "preview",
      preview: {
        actionLabel: "Update project",
        featureGroup: PROJECT_GROUP,
        riskLabels: ["high_risk_write"],
        targets: [{ type: "project", id, name: args.name }],
        expectedChanges: Object.keys(fields).map((key) => `set ${key}`),
        reversibility: "You can update the project again to revert most fields.",
        warnings: ["Updating a project changes live workspace data."],
      },
      operation: {
        actionName: "clockify_projects_update",
        featureGroup: PROJECT_GROUP,
        risks: ["high_risk_write"],
        payload: { id, patch: fields },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; patch: Record<string, unknown> };
    const updated = await ctx.clockify.updateProject(payload.id, payload.patch);
    return successReceipt({
      action: "clockify_projects_update",
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "project", id: updated.id, name: updated.name }] },
    });
  },
});

const archiveProject = defineAction({
  name: "clockify_projects_archive",
  description: "Archive a project (hides it from active lists). Previews and requires confirmation.",
  featureGroup: PROJECT_GROUP,
  risks: ["destructive"],
  schema: z.object({ id: z.string().min(1), name: z.string().optional() }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Archive project",
        featureGroup: PROJECT_GROUP,
        riskLabels: ["destructive"],
        targets: [{ type: "project", id: args.id, name: args.name }],
        expectedChanges: [`Archive project ${args.name ?? args.id}`],
        reversibility: "Archiving is reversible — you can unarchive the project later.",
        warnings: ["Archiving hides the project from active workflows."],
      },
      operation: {
        actionName: "clockify_projects_archive",
        featureGroup: PROJECT_GROUP,
        risks: ["destructive"],
        payload: { id: args.id, name: args.name },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; name?: string };
    const archived = await ctx.clockify.archiveProject(payload.id);
    return successReceipt({
      action: "clockify_projects_archive",
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "project", id: archived.id, name: archived.name }] },
    });
  },
});

const deleteProject = defineAction({
  name: "clockify_projects_delete",
  description:
    "Delete a project (archives first, then deletes — Clockify rejects deleting an active project). Pass the project id (preferred — list projects first to get it), or its exact name and the harness resolves it. Previews and requires confirmation.",
  featureGroup: PROJECT_GROUP,
  risks: ["destructive"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the project id or its exact name.",
    }),
  async handler(ctx, args) {
    let id = args.id;
    let name = args.name;
    // Resolve a name → id when no id was supplied, so a delete never dead-ends on
    // a missing id. Ambiguous identity stops and asks (it never picks one).
    if (!id) {
      const projects = await ctx.clockify.listProjects();
      const match = matchByName(projects, name as string);
      if (match.kind === "none") {
        const options = suggestOptions(projects, name as string);
        return {
          kind: "clarify",
          message: options.length
            ? `I couldn't find an active project named "${name}". Did you mean one of these?`
            : `There are no active projects named "${name}" to delete.`,
          options: options.length ? options : undefined,
        };
      }
      if (match.kind === "many") {
        return {
          kind: "clarify",
          message: `Several active projects are named "${name}". Which one should I delete?`,
          options: match.matches.map((p) => ({ id: p.id, label: p.name })),
        };
      }
      id = match.entity.id;
      name = match.entity.name;
    }
    return {
      kind: "preview",
      preview: {
        actionLabel: "Delete project",
        featureGroup: PROJECT_GROUP,
        riskLabels: ["destructive"],
        targets: [{ type: "project", id, name }],
        expectedChanges: [`Delete project ${name ?? id} (and its tasks)`],
        reversibility: "This cannot be undone.",
        warnings: ["Deleting a project is permanent and removes its tasks."],
      },
      operation: {
        actionName: "clockify_projects_delete",
        featureGroup: PROJECT_GROUP,
        risks: ["destructive"],
        payload: { id, name },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; name?: string };
    await ctx.clockify.deleteProject(payload.id);
    return successReceipt({
      action: "clockify_projects_delete",
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "project", id: payload.id, name: payload.name }] },
    });
  },
});

const rateUpdate = defineAction({
  name: "clockify_projects_rate_update",
  description:
    "Set a project member's billable hourly or cost rate. Billing action — previews and requires confirmation.",
  featureGroup: "invoices",
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
  async handler(ctx, args) {
    const amountMinor = args.amountUnit === "minor" ? Math.round(args.amount) : Math.round(args.amount * 100);
    return {
      kind: "preview",
      preview: {
        actionLabel: `Set project ${args.rateKind === "COST" ? "cost" : "hourly"} rate`,
        featureGroup: "invoices",
        riskLabels: ["billing"],
        targets: [{ type: "project", id: args.projectId }],
        expectedChanges: [
          `Set ${args.rateKind} rate for user ${args.userId} to ${amountMinor} (minor units)`,
        ],
        reversibility: "You can set a new rate at any time; past entries keep their recorded rate.",
        warnings: ["This changes the billable amount of future entries."],
      },
      operation: {
        actionName: "clockify_projects_rate_update",
        featureGroup: "invoices",
        risks: ["billing"],
        payload: {
          projectId: args.projectId,
          userId: args.userId,
          rateKind: args.rateKind,
          amountMinor,
          since: args.since,
        },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as {
      projectId: string;
      userId: string;
      rateKind: "HOURLY" | "COST";
      amountMinor: number;
      since?: string;
    };
    await ctx.clockify.updateProjectRate(payload);
    return successReceipt({
      action: "clockify_projects_rate_update",
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "project", id: payload.projectId }] },
    });
  },
});

const estimateUpdate = defineAction({
  name: "clockify_projects_estimate_update",
  description:
    "Update a project's time/budget estimate. Elevated write — previews and requires confirmation.",
  featureGroup: PROJECT_GROUP,
  risks: ["high_risk_write"],
  schema: z.object({
    id: z.string().min(1),
    fields: z.record(z.string(), z.unknown()).refine((f) => Object.keys(f).length > 0, {
      message: "Provide at least one estimate field.",
    }),
  }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Update project estimate",
        featureGroup: PROJECT_GROUP,
        riskLabels: ["high_risk_write"],
        targets: [{ type: "project", id: args.id }],
        expectedChanges: Object.keys(args.fields).map((key) => `set estimate ${key}`),
        reversibility: "You can update the estimate again at any time.",
        warnings: ["Changing the estimate affects progress and budget reporting."],
      },
      operation: {
        actionName: "clockify_projects_estimate_update",
        featureGroup: PROJECT_GROUP,
        risks: ["high_risk_write"],
        payload: { id: args.id, fields: args.fields },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; fields: Record<string, unknown> };
    await ctx.clockify.updateProjectEstimate(payload.id, payload.fields);
    return successReceipt({
      action: "clockify_projects_estimate_update",
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "project", id: payload.id }] },
    });
  },
});

const membershipsUpdate = defineAction({
  name: "clockify_projects_memberships_update",
  description:
    "Replace a project's membership set (who can access/track it). Elevated write — previews and requires confirmation.",
  featureGroup: "users_groups",
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
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Update project memberships",
        featureGroup: "users_groups",
        riskLabels: ["high_risk_write"],
        targets: [{ type: "project", id: args.id }],
        expectedChanges: [`Replace membership set (${args.memberships.length} member(s))`],
        reversibility: "You can update memberships again to restore prior access.",
        warnings: ["This replaces who can access and track time on the project."],
      },
      operation: {
        actionName: "clockify_projects_memberships_update",
        featureGroup: "users_groups",
        risks: ["high_risk_write"],
        payload: { id: args.id, memberships: args.memberships },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; memberships: Array<Record<string, unknown>> };
    await ctx.clockify.updateProjectMemberships(payload.id, { memberships: payload.memberships });
    return successReceipt({
      action: "clockify_projects_memberships_update",
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "project", id: payload.id }] },
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
