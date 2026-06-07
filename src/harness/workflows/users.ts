import { z } from "zod";
import { defineAction, type ActionDefinition } from "../action.js";
import { successReceipt, errorReceipt } from "../receipts.js";

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

const listUsers = defineAction({
  name: "clockify_users_list",
  description: "List workspace users.",
  featureGroup: UG,
  risks: ["read"],
  schema: z.object({}),
  async handler(ctx) {
    const items = await ctx.clockify.listUsers();
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_users_list", entity: "user", ids: { workspaceId: ctx.workspaceId }, data: { count: items.length, items } }) };
  },
});

const inviteUser = defineAction({
  name: "clockify_users_invite",
  description: "Invite a user to the workspace by email. External side effect (may email) — previews and requires confirmation. Email is NOT sent unless sendEmail is true.",
  featureGroup: UG,
  risks: ["external_side_effect"],
  schema: z.object({ email: z.string().email(), sendEmail: z.boolean().default(false) }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Invite user",
        featureGroup: UG,
        riskLabels: ["external_side_effect"],
        targets: [],
        expectedChanges: [`Invite ${args.email} to the workspace${args.sendEmail ? " (send email)" : " (no email)"}`],
        reversibility: "You can deactivate the user afterward.",
        warnings: [args.sendEmail ? "This adds a user and emails them an invitation." : "This adds a user to the workspace."],
      },
      operation: { actionName: "clockify_users_invite", featureGroup: UG, risks: ["external_side_effect"], payload: { email: args.email, sendEmail: args.sendEmail } },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { email: string; sendEmail: boolean };
    const user = await ctx.clockify.inviteUser(payload.email, payload.sendEmail);
    return successReceipt({ action: "clockify_users_invite", entity: "user", ids: { workspaceId: ctx.workspaceId }, changed: { created: [{ type: "user", id: user.id, name: user.name }] } });
  },
});

const updateRole = defineAction({
  name: "clockify_users_role_update",
  description: "Update a user's workspace role (WORKSPACE_ADMIN/PROJECT_MANAGER/TEAM_MANAGER). Elevated write — previews and requires confirmation.",
  featureGroup: UG,
  risks: ["high_risk_write"],
  schema: z.object({ userId: z.string().min(1), role: z.enum(["WORKSPACE_ADMIN", "PROJECT_MANAGER", "TEAM_MANAGER"]), entityId: z.string().min(1) }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Update user role",
        featureGroup: UG,
        riskLabels: ["high_risk_write"],
        targets: [{ type: "user", id: args.userId }],
        expectedChanges: [`Set ${args.role} for user ${args.userId} on ${args.entityId}`],
        reversibility: "You can change the role again.",
        warnings: ["This changes a user's permissions."],
      },
      operation: { actionName: "clockify_users_role_update", featureGroup: UG, risks: ["high_risk_write"], payload: { userId: args.userId, role: args.role, entityId: args.entityId } },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { userId: string; role: string; entityId: string };
    const result = await ctx.clockify.updateUserRole(payload.userId, payload.role, payload.entityId);
    return successReceipt({ action: "clockify_users_role_update", entity: "user", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "user", id: result.id, name: result.name }] } });
  },
});

const deactivateUser = defineAction({
  name: "clockify_users_deactivate",
  description: "Deactivate a workspace user (removes their access). Elevated write — previews and requires confirmation.",
  featureGroup: UG,
  risks: ["high_risk_write"],
  schema: z.object({ userId: z.string().min(1) }),
  async handler(ctx, args) {
    // Self-deactivation guard (defense in depth): refuse to lock the admin out.
    if (args.userId === ctx.adminUserId) {
      return { kind: "receipt", receipt: errorReceipt({ action: "clockify_users_deactivate", code: "invalid_args", message: "Refusing to deactivate yourself — that could lock you out of the workspace." }) };
    }
    return {
      kind: "preview",
      preview: {
        actionLabel: "Deactivate user",
        featureGroup: UG,
        riskLabels: ["high_risk_write"],
        targets: [{ type: "user", id: args.userId }],
        expectedChanges: [`Deactivate user ${args.userId}`],
        reversibility: "Reactivate the user from the Clockify UI to restore access.",
        warnings: ["This removes the user's access to the workspace."],
      },
      operation: { actionName: "clockify_users_deactivate", featureGroup: UG, risks: ["high_risk_write"], payload: { userId: args.userId } },
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

const listGroups = defineAction({
  name: "clockify_groups_list",
  description: "List user groups.",
  featureGroup: UG,
  risks: ["read"],
  schema: z.object({}),
  async handler(ctx) {
    const items = await ctx.clockify.listGroups();
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_groups_list", entity: "group", ids: { workspaceId: ctx.workspaceId }, data: { count: items.length, items } }) };
  },
});

const getGroup = defineAction({
  name: "clockify_groups_get",
  description: "Fetch a single user group by id.",
  featureGroup: UG,
  risks: ["read"],
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getGroup(args.id);
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_groups_get", entity: "group", ids: { workspaceId: ctx.workspaceId }, data: { entity } }) };
  },
});

const createGroup = defineAction({
  name: "clockify_groups_create",
  description: "Create a user group. Elevated write — previews and requires confirmation.",
  featureGroup: UG,
  risks: ["high_risk_write"],
  schema: z.object({ name: z.string().min(1) }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: { actionLabel: "Create user group", featureGroup: UG, riskLabels: ["high_risk_write"], targets: [], expectedChanges: [`Create user group "${args.name}"`], reversibility: "You can delete the group afterward.", warnings: ["This adds a user group to the workspace."] },
      operation: { actionName: "clockify_groups_create", featureGroup: UG, risks: ["high_risk_write"], payload: { name: args.name } },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { name: string };
    const group = await ctx.clockify.createGroup(payload.name);
    return successReceipt({ action: "clockify_groups_create", entity: "group", ids: { workspaceId: ctx.workspaceId }, changed: { created: [{ type: "group", id: group.id, name: group.name }] } });
  },
});

const updateGroup = defineAction({
  name: "clockify_groups_update",
  description: "Rename a user group. Elevated write — previews and requires confirmation.",
  featureGroup: UG,
  risks: ["high_risk_write"],
  schema: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: { actionLabel: "Update user group", featureGroup: UG, riskLabels: ["high_risk_write"], targets: [{ type: "group", id: args.id, name: args.name }], expectedChanges: [`Rename group to "${args.name}"`], reversibility: "You can rename the group again.", warnings: ["This changes a workspace user group."] },
      operation: { actionName: "clockify_groups_update", featureGroup: UG, risks: ["high_risk_write"], payload: { id: args.id, name: args.name } },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; name: string };
    const group = await ctx.clockify.updateGroup(payload.id, payload.name);
    return successReceipt({ action: "clockify_groups_update", entity: "group", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "group", id: group.id, name: group.name }] } });
  },
});

const deleteGroup = defineAction({
  name: "clockify_groups_delete",
  description: "Delete a user group. Destructive — previews and requires confirmation.",
  featureGroup: UG,
  risks: ["destructive"],
  schema: z.object({ id: z.string().min(1), name: z.string().optional() }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: { actionLabel: "Delete user group", featureGroup: UG, riskLabels: ["destructive"], targets: [{ type: "group", id: args.id, name: args.name }], expectedChanges: [`Delete user group ${args.name ?? args.id}`], reversibility: "This cannot be undone.", warnings: ["Deleting a group removes its membership grouping."] },
      operation: { actionName: "clockify_groups_delete", featureGroup: UG, risks: ["destructive"], payload: { id: args.id, name: args.name } },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; name?: string };
    await ctx.clockify.deleteGroup(payload.id);
    return successReceipt({ action: "clockify_groups_delete", entity: "group", ids: { workspaceId: ctx.workspaceId }, changed: { deleted: [{ type: "group", id: payload.id, name: payload.name }] } });
  },
});

const addUser = defineAction({
  name: "clockify_groups_add_user",
  description: "Add a user to a group. Elevated write — previews and requires confirmation.",
  featureGroup: UG,
  risks: ["high_risk_write"],
  schema: z.object({ groupId: z.string().min(1), userId: z.string().min(1) }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: { actionLabel: "Add user to group", featureGroup: UG, riskLabels: ["high_risk_write"], targets: [{ type: "group", id: args.groupId }], expectedChanges: [`Add user ${args.userId} to group ${args.groupId}`], reversibility: "You can remove the user from the group afterward.", warnings: ["This changes group membership (may affect permissions)."] },
      operation: { actionName: "clockify_groups_add_user", featureGroup: UG, risks: ["high_risk_write"], payload: { groupId: args.groupId, userId: args.userId } },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { groupId: string; userId: string };
    await ctx.clockify.addUserToGroup(payload.groupId, payload.userId);
    return successReceipt({ action: "clockify_groups_add_user", entity: "group", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "group", id: payload.groupId }] } });
  },
});

const removeUser = defineAction({
  name: "clockify_groups_remove_user",
  description: "Remove a user from a group. Destructive — previews and requires confirmation.",
  featureGroup: UG,
  risks: ["destructive"],
  schema: z.object({ groupId: z.string().min(1), userId: z.string().min(1) }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: { actionLabel: "Remove user from group", featureGroup: UG, riskLabels: ["destructive"], targets: [{ type: "group", id: args.groupId }], expectedChanges: [`Remove user ${args.userId} from group ${args.groupId}`], reversibility: "You can re-add the user to the group.", warnings: ["This changes group membership (may affect permissions)."] },
      operation: { actionName: "clockify_groups_remove_user", featureGroup: UG, risks: ["destructive"], payload: { groupId: args.groupId, userId: args.userId } },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { groupId: string; userId: string };
    await ctx.clockify.removeUserFromGroup(payload.groupId, payload.userId);
    return successReceipt({ action: "clockify_groups_remove_user", entity: "group", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "group", id: payload.groupId }] } });
  },
});

export const USER_GROUP_ACTIONS: ActionDefinition[] = [
  listUsers, inviteUser, updateRole, deactivateUser,
  listGroups, getGroup, createGroup, updateGroup, deleteGroup, addUser, removeUser,
];
