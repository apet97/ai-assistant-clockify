import { z } from "zod";
import { randomUUID } from "node:crypto";
import { zStringList } from "../arg-shapes.js";
import {
  clarifyResult,
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionContext,
  type ActionDefinition,
} from "../action.js";
import { successReceipt, errorReceipt } from "../receipts.js";
import { toMinor } from "../money.js";
import { matchByName, resolveEntityRef, resolveUserRef, resolveUserRefs, suggestOptions } from "./resolve.js";
import { RATE_FIELDS, buildRatePreview } from "./rate.js";

/**
 * Typed user & group workflows (goclmcp §2.13). Reads (list/get) execute
 * immediately; every write runs preview→commit. Risk classes: invite =
 * external_side_effect (may email); role_update / deactivate / group create/update
 * / add_user = high_risk_write; group delete / remove_user = destructive. All
 * gated by `users_groups`. These are real Clockify permission-affecting writes, so
 * they use high_risk_write / external_side_effect / destructive (which keep the
 * policy gate), NEVER `permission_change` (which would bypass it) — the deliberate
 * D3 deviation per the permission-change note.
 */

const UG = "users_groups" as const;

// ── Users ───────────────────────────────────────────────────────────────────

const listUsers = defineReadAction({
  name: "clockify_users_list",
  description: "List workspace users.",
  group: UG,
  schema: z.object({}),
  async handler(ctx) {
    const items = await ctx.clockify.listUsers();
    return successReceipt({ action: "clockify_users_list", entity: "user", ids: { workspaceId: ctx.workspaceId }, data: { count: items.length, items } });
  },
});

const inviteUser = defineRiskyAction({
  name: "clockify_users_invite",
  description: "Invite a user to the workspace by email. External side effect (may email) — previews and requires confirmation. Email is NOT sent unless sendEmail is true.",
  group: UG,
  risks: ["external_side_effect"],
  schema: z.object({ email: z.string().email(), sendEmail: z.boolean().default(false) }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Invite user",
      targets: [],
      expectedChanges: [`Invite ${args.email} to the workspace${args.sendEmail ? " (send email)" : " (no email)"}`],
      reversibility: "You can deactivate the user afterward.",
      warnings: [args.sendEmail ? "This adds a user and emails them an invitation." : "This adds a user to the workspace."],
      payload: { email: args.email, sendEmail: args.sendEmail },
    };
  },
  async commit(ctx, payload) {
    const { email, sendEmail } = payload as { email: string; sendEmail: boolean };
    const user = await ctx.clockify.inviteUser(email, sendEmail);
    return successReceipt({ action: "clockify_users_invite", entity: "user", ids: { workspaceId: ctx.workspaceId }, changed: { created: [{ type: "user", id: user.id, name: user.name }] } });
  },
});

const updateRole = defineRiskyAction({
  name: "clockify_users_role_update",
  description:
    "Give a workspace member a manager role; the SCOPE depends on the role (live-verified): WORKSPACE_ADMIN = the whole workspace (no scope needed); PROJECT_MANAGER = a project (pass `projectId` or exact `projectName`); TEAM_MANAGER of a user group (pass `groupId` or exact `groupName`) or of a project (`projectId`/`projectName`). Pass the RECIPIENT by `userId`/`userName` (or 'me'). Elevated write — previews and requires confirmation.",
  group: UG,
  risks: ["high_risk_write"],
  schema: z
    .object({
      /** The user RECEIVING the role — an id, exact name (via userName), or 'me'. */
      userId: z.string().min(1).optional(),
      userName: z.string().min(1).optional(),
      role: z.enum(["WORKSPACE_ADMIN", "PROJECT_MANAGER", "TEAM_MANAGER"]),
      /** PROJECT_MANAGER / TEAM_MANAGER scope: the project the role applies to. */
      projectId: z.string().min(1).optional(),
      projectName: z.string().min(1).optional(),
      /** TEAM_MANAGER scope: the user group the role applies to. */
      groupId: z.string().min(1).optional(),
      groupName: z.string().min(1).optional(),
    })
    .refine((v) => v.userId !== undefined || v.userName !== undefined, {
      message: "Provide the user (id or exact name) to give the role to.",
    }),
  async preview(ctx, args) {
    // 1) RECIPIENT — the URL user. resolveUserRef VERIFIES it is a real workspace
    // member (a 24-hex id that is actually a project sails past a trust-the-id
    // path), so an identity mistake clarifies at preview, never confirmed-then-failed.
    const recipient = await resolveUserRef(
      { id: args.userId, name: args.userName },
      { verb: `give the ${args.role} role to`, adminUserId: ctx.adminUserId, listUsers: () => ctx.clockify.listUsers() },
    );
    if (!recipient.ok) return recipient.clarify;
    const granteeId = recipient.userId;
    const granteeName = recipient.label;

    // 2) SCOPE (entityId) — live-verified contract: WORKSPACE_ADMIN = workspaceId
    // (no sourceType); a group = the group id + sourceType USER_GROUP (TEAM_MANAGER);
    // a project = the project id, no sourceType (PROJECT_MANAGER / TEAM_MANAGER).
    let entityId: string;
    let sourceType: string | undefined;
    let scopeLabel: string;
    if (args.role === "WORKSPACE_ADMIN") {
      entityId = ctx.workspaceId;
      scopeLabel = "the whole workspace";
    } else if (args.groupId || args.groupName) {
      const groups = await ctx.clockify.listGroups();
      let group = args.groupId ? groups.find((g) => g.id === args.groupId) : undefined;
      if (!group && args.groupName) {
        const m = matchByName(groups, args.groupName);
        if (m.kind === "many") return { clarify: `Several user groups match "${args.groupName}". Which one?`, options: m.matches.map((g) => ({ id: g.id, label: g.name })) };
        if (m.kind === "one") group = m.entity;
      }
      if (!group) {
        const target = args.groupName ?? args.groupId ?? "";
        return { clarify: `I couldn't find a user group "${target}". Which group should ${granteeName} manage?`, options: suggestOptions(groups, target) };
      }
      entityId = group.id;
      sourceType = "USER_GROUP";
      scopeLabel = `the "${group.name}" group`;
    } else if (args.projectId || args.projectName) {
      const projects = await ctx.clockify.listProjects();
      let project = args.projectId ? projects.find((p) => p.id === args.projectId) : undefined;
      if (!project && args.projectName) {
        const m = matchByName(projects, args.projectName);
        if (m.kind === "many") return { clarify: `Several projects match "${args.projectName}". Which one?`, options: m.matches.map((p) => ({ id: p.id, label: p.name })) };
        if (m.kind === "one") project = m.entity;
      }
      if (!project) {
        const target = args.projectName ?? args.projectId ?? "";
        return { clarify: `I couldn't find an active project "${target}". Which project should ${granteeName} manage?`, options: suggestOptions(projects, target) };
      }
      entityId = project.id;
      scopeLabel = `the "${project.name}" project`;
    } else {
      return { clarify: `Which ${args.role === "TEAM_MANAGER" ? "project or user group" : "project"} should ${granteeName} manage as ${args.role}? Give me its exact name.` };
    }

    return {
      actionLabel: "Update user role",
      targets: [{ type: "user", id: granteeId }],
      expectedChanges: [`Make ${granteeName} a ${args.role} for ${scopeLabel}`],
      reversibility: "You can change the role again.",
      warnings: ["This changes a user's workspace permissions."],
      payload: { granteeId, role: args.role, entityId, sourceType },
    };
  },
  async commit(ctx, payload) {
    const { granteeId, role, entityId, sourceType } = payload as { granteeId: string; role: string; entityId: string; sourceType?: string };
    // POST /users/{recipient}/roles {entityId: scope, role, sourceType?} — recipient
    // in the URL, scope (workspace/project/group) in entityId. Live-verified 2026-06-12.
    await ctx.clockify.updateUserRole(granteeId, role, entityId, sourceType);
    return successReceipt({ action: "clockify_users_role_update", entity: "user", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "user", id: granteeId, name: role }] } });
  },
});

const rateUpdate = defineRiskyAction({
  name: "clockify_users_rate_update",
  description:
    'Set a workspace member\'s default billable hourly or cost rate — the rate shown in the Team section (distinct from a per-project member rate). Pass the member by `userId`/`userName` (or "me"). `amount` is major units (e.g. 75 = 75.00) unless `amountUnit` is \'minor\'. Billing action — previews and requires confirmation.',
  group: "invoices",
  risks: ["billing"],
  schema: z
    .object({
      /** The member's user id, exact name (via userName), or "me" (resolved server-side). */
      userId: z.string().min(1).optional(),
      userName: z.string().min(1).optional(),
      ...RATE_FIELDS,
    })
    .refine((v) => v.userId !== undefined || v.userName !== undefined, { message: "Provide the member (id or exact name, or 'me')." }),
  async preview(ctx, args) {
    // Resolve + VERIFY the member ("me" -> admin; a name -> a user id). A 24-hex
    // id that is actually a project/task sails past a trust-the-id path and the
    // rate PUT 404s, so resolveUserRef confirms a real workspace user at preview.
    const member = await resolveUserRef(
      { id: args.userId, name: args.userName },
      { verb: "set a rate for", adminUserId: ctx.adminUserId, listUsers: () => ctx.clockify.listUsers() },
    );
    if (!member.ok) return member.clarify;
    const userId = member.userId;
    const memberLabel = member.label;
    const amountMinor = toMinor(args.amount, args.amountUnit);
    return {
      ...buildRatePreview({
        targetType: "user",
        targetId: userId,
        scopeLabel: `for ${memberLabel}`,
        amountMinor,
        rateKind: args.rateKind,
        kindNoun: "member",
      }),
      payload: { userId, rateKind: args.rateKind, amountMinor, since: args.since },
    };
  },
  async commit(ctx, payload) {
    const operation = payload as { userId: string; rateKind: "HOURLY" | "COST"; amountMinor: number; since?: string };
    await ctx.clockify.updateWorkspaceMemberRate(operation);
    return successReceipt({ action: "clockify_users_rate_update", entity: "user", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "user", id: operation.userId }] } });
  },
});

// Self-deactivation guard returns an ERROR receipt from the handler (not a clarify),
// which the risky preview/commit shape cannot express — so this stays a hand-rolled
// defineAction to keep the guard byte-identical.
const deactivateUser = defineAction({
  name: "clockify_users_deactivate",
  description:
    "Deactivate a workspace user (removes their access). Pass the member by `userId`/`userName` — an id or the exact name, resolved + verified server-side. Elevated write — previews and requires confirmation.",
  featureGroup: UG,
  risks: ["high_risk_write"],
  schema: z
    .object({
      userId: z.string().min(1).optional(),
      userName: z.string().min(1).optional(),
    })
    .refine((v) => v.userId !== undefined || v.userName !== undefined, {
      message: "Provide the member (id or exact name).",
    }),
  async handler(ctx, args) {
    // Resolve + VERIFY the member first (a name in either slot, a wrong-typed
    // 24-hex id ⇒ clarify) so the self-deactivation guard below holds on the
    // RESOLVED id — 'me' or the admin's own name must not slip past it.
    const member = await resolveUserRef(
      { id: args.userId, name: args.userName },
      { verb: "deactivate", adminUserId: ctx.adminUserId, listUsers: () => ctx.clockify.listUsers() },
    );
    if (!member.ok) {
      return clarifyResult(member.clarify);
    }
    // Self-deactivation guard (defense in depth): refuse to lock the admin out.
    if (member.userId === ctx.adminUserId) {
      return { kind: "receipt", receipt: errorReceipt({ action: "clockify_users_deactivate", code: "invalid_args", message: "Refusing to deactivate yourself — that could lock you out of the workspace." }) };
    }
    const label = member.label === "you" ? member.userId : member.label;
    return {
      kind: "preview",
      preview: {
        actionLabel: "Deactivate user",
        featureGroup: UG,
        riskLabels: ["high_risk_write"],
        targets: [{ type: "user", id: member.userId, name: label }],
        expectedChanges: [`Deactivate user ${label}`],
        reversibility: "Reactivate the user from the Clockify UI to restore access.",
        warnings: ["This removes the user's access to the workspace."],
      },
      operation: { operationId: randomUUID(), actionName: "clockify_users_deactivate", featureGroup: UG, risks: ["high_risk_write"], payload: { userId: member.userId } },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { userId: string };
    // Re-check the self-deactivation guard at commit (policy is re-checked too).
    if (payload.userId === ctx.adminUserId) {
      return errorReceipt({ action: "clockify_users_deactivate", code: "invalid_args", message: "Refusing to deactivate yourself." });
    }
    const result = await ctx.clockify.deactivateUser(payload.userId);
    return successReceipt({ action: "clockify_users_deactivate", entity: "user", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "user", id: result.id, name: result.name }] } });
  },
});

// ── Groups ──────────────────────────────────────────────────────────────────

const listGroups = defineReadAction({
  name: "clockify_groups_list",
  description: "List user groups.",
  group: UG,
  schema: z.object({}),
  async handler(ctx) {
    const items = await ctx.clockify.listGroups();
    return successReceipt({ action: "clockify_groups_list", entity: "group", ids: { workspaceId: ctx.workspaceId }, data: { count: items.length, items } });
  },
});

const getGroup = defineAction({
  name: "clockify_groups_get",
  description: "Fetch a single user group by id, or by its exact `name` (resolved server-side).",
  featureGroup: UG,
  risks: ["read"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the group id or its exact name.",
    }),
  async handler(ctx, args) {
    const resolved = await resolveEntityRef(args, {
      noun: "group",
      verb: "fetch",
      list: () => ctx.clockify.listGroups(),
    });
    if (!resolved.ok) {
      return clarifyResult(resolved.clarify);
    }
    const entity = await ctx.clockify.getGroup(resolved.id);
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_groups_get", entity: "group", ids: { workspaceId: ctx.workspaceId }, data: { entity } }) };
  },
});

const createGroup = defineRiskyAction({
  name: "clockify_groups_create",
  description: "Create a user group. Elevated write — previews and requires confirmation.",
  group: UG,
  risks: ["high_risk_write"],
  schema: z.object({ name: z.string().min(1) }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Create user group",
      targets: [],
      expectedChanges: [`Create user group "${args.name}"`],
      reversibility: "You can delete the group afterward.",
      warnings: ["This adds a user group to the workspace."],
      payload: { name: args.name },
    };
  },
  async commit(ctx, payload) {
    const { name } = payload as { name: string };
    const group = await ctx.clockify.createGroup(name);
    return successReceipt({ action: "clockify_groups_create", entity: "group", ids: { workspaceId: ctx.workspaceId }, changed: { created: [{ type: "group", id: group.id, name: group.name }] } });
  },
});

const updateGroup = defineRiskyAction({
  name: "clockify_groups_update",
  description: "Rename a user group. Elevated write — previews and requires confirmation.",
  group: UG,
  risks: ["high_risk_write"],
  schema: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Update user group",
      targets: [{ type: "group", id: args.id, name: args.name }],
      expectedChanges: [`Rename group to "${args.name}"`],
      reversibility: "You can rename the group again.",
      warnings: ["This changes a workspace user group."],
      payload: { id: args.id, name: args.name },
    };
  },
  async commit(ctx, payload) {
    const { id, name } = payload as { id: string; name: string };
    const group = await ctx.clockify.updateGroup(id, name);
    return successReceipt({ action: "clockify_groups_update", entity: "group", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "group", id: group.id, name: group.name }] } });
  },
});

const deleteGroup = defineRiskyAction({
  name: "clockify_groups_delete",
  description:
    "Delete a user group. Pass the group id, or its exact `name` and the harness resolves it. Destructive — previews and requires confirmation.",
  group: UG,
  risks: ["destructive"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the group id or its exact name.",
    }),
  async preview(ctx, args) {
    const resolved = await resolveEntityRef(args, {
      noun: "user group",
      verb: "delete",
      list: () => ctx.clockify.listGroups(),
    });
    if (!resolved.ok) return resolved.clarify;
    const name = resolved.name ?? args.name;
    return {
      actionLabel: "Delete user group",
      targets: [{ type: "group", id: resolved.id, name }],
      expectedChanges: [`Delete user group ${name ?? resolved.id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting a group removes its membership grouping."],
      payload: { id: resolved.id, name },
    };
  },
  async commit(ctx, payload) {
    const { id, name } = payload as { id: string; name?: string };
    await ctx.clockify.deleteGroup(id);
    return successReceipt({ action: "clockify_groups_delete", entity: "group", ids: { workspaceId: ctx.workspaceId }, changed: { deleted: [{ type: "group", id, name }] } });
  },
});

/**
 * Resolve the GROUP every membership write targets, by id or exact name, so a bad
 * group reference clarifies at PREVIEW. The member(s) are resolved separately
 * (singular for remove, a verified LIST for add) — both clarify before the confirm
 * button so a name in an id slot is never a confirmed-then-failed commit.
 */
function resolveGroupRef(ctx: ActionContext, args: { groupId?: string; groupName?: string }, verb: string) {
  return resolveEntityRef(
    { id: args.groupId, name: args.groupName },
    { noun: "user group", verb, list: () => ctx.clockify.listGroups() },
  );
}

const addUser = defineRiskyAction({
  name: "clockify_groups_add_user",
  description:
    "Add one or more members to a group. Pass the group by `groupId`/`groupName` and the members by `members` (an array where each entry is a user id, exact name, or 'me'); a single `userId`/`userName` is also accepted. The harness resolves names server-side and clarifies on an unknown one. Elevated write — previews ALL the adds as ONE card and requires confirmation.",
  group: UG,
  risks: ["high_risk_write"],
  schema: z
    .object({
      groupId: z.string().min(1).optional(),
      groupName: z.string().min(1).optional(),
      /** Members to add: user ids, exact names, or 'me' (resolved + verified server-side). */
      members: zStringList().optional(),
      // Single-member shape, tolerated because the planner emits both.
      userId: z.string().min(1).optional(),
      userName: z.string().min(1).optional(),
    })
    .refine((v) => v.groupId !== undefined || v.groupName !== undefined, { message: "Provide the group id or its exact name." })
    .refine((v) => (v.members?.length ?? 0) > 0 || v.userId !== undefined || v.userName !== undefined, {
      message: "Provide at least one member (id, exact name, or 'me').",
    }),
  async preview(ctx, args) {
    const group = await resolveGroupRef(ctx, args, "add members to");
    if (!group.ok) return group.clarify;
    const refs = [...(args.members ?? []), ...(args.userId ? [args.userId] : []), ...(args.userName ? [args.userName] : [])];
    const members = await resolveUserRefs(refs, {
      verb: "add",
      adminUserId: ctx.adminUserId,
      listUsers: () => ctx.clockify.listUsers(),
      verifyIds: true,
    });
    if (!members.ok) return members.clarify;
    const many = members.userIds.length > 1;
    return {
      actionLabel: many ? "Add users to group" : "Add user to group",
      targets: [{ type: "group", id: group.id, name: group.name }],
      expectedChanges: [`Add ${members.labels.join(", ")} to group "${group.name ?? group.id}"`],
      reversibility: "You can remove the user from the group afterward.",
      warnings: ["This changes group membership (may affect permissions)."],
      payload: { groupId: group.id, userIds: members.userIds },
    };
  },
  async commit(ctx, payload) {
    const { groupId, userIds } = payload as { groupId: string; userIds: string[] };
    // POST /user-groups/{id}/users adds ONE member (it appends, not replaces), so
    // each add is an independent call — done in turn over the previewed members.
    for (const userId of userIds) await ctx.clockify.addUserToGroup(groupId, userId);
    return successReceipt({ action: "clockify_groups_add_user", entity: "group", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "group", id: groupId }] } });
  },
});

const removeUser = defineRiskyAction({
  name: "clockify_groups_remove_user",
  description:
    "Remove a user from a group. Pass the group by `groupId`/`groupName` and the user by `userId`/`userName` (or 'me') — the harness resolves names server-side and clarifies on an unknown one. Destructive — previews and requires confirmation.",
  group: UG,
  risks: ["destructive"],
  schema: z
    .object({
      groupId: z.string().min(1).optional(),
      groupName: z.string().min(1).optional(),
      userId: z.string().min(1).optional(),
      userName: z.string().min(1).optional(),
    })
    .refine((v) => v.groupId !== undefined || v.groupName !== undefined, { message: "Provide the group id or its exact name." })
    .refine((v) => v.userId !== undefined || v.userName !== undefined, { message: "Provide the user (id or exact name, or 'me')." }),
  async preview(ctx, args) {
    const group = await resolveGroupRef(ctx, args, "remove a member from");
    if (!group.ok) return group.clarify;
    const user = await resolveUserRef(
      { id: args.userId, name: args.userName },
      { verb: "remove", adminUserId: ctx.adminUserId, listUsers: () => ctx.clockify.listUsers() },
    );
    if (!user.ok) return user.clarify;
    return {
      actionLabel: "Remove user from group",
      targets: [{ type: "group", id: group.id, name: group.name }],
      expectedChanges: [`Remove ${user.label} from group "${group.name ?? group.id}"`],
      reversibility: "You can re-add the user to the group.",
      warnings: ["This changes group membership (may affect permissions)."],
      payload: { groupId: group.id, userId: user.userId },
    };
  },
  async commit(ctx, payload) {
    const { groupId, userId } = payload as { groupId: string; userId: string };
    await ctx.clockify.removeUserFromGroup(groupId, userId);
    return successReceipt({ action: "clockify_groups_remove_user", entity: "group", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "group", id: groupId }] } });
  },
});

export const USER_GROUP_ACTIONS: ActionDefinition[] = [
  listUsers, inviteUser, updateRole, rateUpdate, deactivateUser,
  listGroups, getGroup, createGroup, updateGroup, deleteGroup, addUser, removeUser,
];
