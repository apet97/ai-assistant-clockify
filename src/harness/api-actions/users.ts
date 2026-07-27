import { z } from "zod";
import {
  defineWorkspaceMemberRateAction,
  previewWorkspaceMemberRate,
  USER_GROUP_API_METADATA,
  USER_RATE_LITERAL_ALIASES,
  workspaceMemberRateSchema,
} from "../workflows/users.js";
import { defineRiskyAction, type ActionDefinition } from "../action.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { commitSingleDurableRiskyStep } from "../durable-risky-write.js";
import { successReceipt } from "../receipts.js";
import { dispatchWithReconciliation } from "../workflows/structure-durable.js";
import { captureTargetSnapshot } from "../target-snapshots.js";
import { resolveEntityRef, resolveUserRef } from "../workflows/resolve.js";
import type { ApiAccess, ApiActionMetadataCarrier, ApiMethod, AvailabilityByAuthClass, MaterialFieldMetadata } from "../api-operation.js";

const UG = "users_groups" as const;

const USER_GROUP_AVAILABILITY: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: true }),
  api_key: Object.freeze({ available: true }),
});

function userGroupEndpointKey(access: ApiAccess, method: ApiMethod, path: string, sourceModule = "users.ts"): string {
  return [access, "api", method, path, sourceModule].join("\0");
}

function userGroupMaterialField(path: string, label: string, formatterId: string, requiredInPreview: boolean): MaterialFieldMetadata {
  return Object.freeze({ kind: "value", path, label, formatterId, formatterVersion: 1, requiredInPreview });
}

function userGroupApiMetadata(input: {
  actionName: string;
  operationId: string;
  method: ApiMethod;
  path: string;
  access: ApiAccess;
  primary: string;
  support: readonly string[];
  materialFields: readonly MaterialFieldMetadata[];
}): ApiActionMetadataCarrier {
  return Object.freeze({
    apiExposure: "api",
    apiOperation: Object.freeze({
      operationId: input.operationId,
      host: "api",
      method: input.method,
      path: input.path,
      access: input.access,
      exposure: "api",
    }),
    adapterEndpoints: Object.freeze({ primary: Object.freeze([input.primary]), support: Object.freeze([...input.support]) }),
    availabilityByAuthClass: USER_GROUP_AVAILABILITY,
    boundedArgumentDictionaries: Object.freeze([]),
    materialFields: Object.freeze([...input.materialFields]),
    presentation: Object.freeze({ presenterId: input.actionName, version: 1 }),
  });
}

const userGroupEndpoint = Object.freeze({
  groupsList: userGroupEndpointKey("read", "GET", "/workspaces/{workspaceId}/user-groups"),
  groupsAddUser: userGroupEndpointKey("write", "POST", "/workspaces/{workspaceId}/user-groups/{groupId}/users"),
  usersList: userGroupEndpointKey("read", "GET", "/workspaces/{workspaceId}/users"),
});

export const GROUP_MEMBERSHIP_API_METADATA = Object.freeze({
  clockify_groups_add_member: userGroupApiMetadata({
    actionName: "clockify_groups_add_member",
    operationId: "addUser",
    method: "POST",
    path: "/workspaces/{workspaceId}/user-groups/{groupId}/users",
    access: "write",
    primary: userGroupEndpoint.groupsAddUser,
    support: [userGroupEndpoint.groupsList, userGroupEndpoint.usersList],
    materialFields: [
      userGroupMaterialField("/groupId", "Group", "entity", true),
      userGroupMaterialField("/userId", "User", "entity", true),
    ],
  }),
});

const membershipContract = durableMutationContract({
  source: "confirmed", targeting: { mode: "snapshots", relations: ["parent", "target"] }, strategies: ["update"],
});

const hourlyRateUpdate = defineWorkspaceMemberRateAction({
  name: "clockify_users_hourly_rate_update",
  metadataKey: "clockify_users_hourly_rate_update",
  rateKind: "HOURLY",
  planStepId: "update-user-hourly-rate",
  stepName: "Update workspace member hourly rate",
  rateLabel: "hourly",
  dispatchKey: "updateWorkspaceMemberHourlyRateAtomic",
});

const costRateUpdate = defineWorkspaceMemberRateAction({
  name: "clockify_users_cost_rate_update",
  metadataKey: "clockify_users_cost_rate_update",
  rateKind: "COST",
  planStepId: "update-user-cost-rate",
  stepName: "Update workspace member cost rate",
  rateLabel: "cost",
  dispatchKey: "updateWorkspaceMemberCostRateAtomic",
});

const addMember = defineRiskyAction({
  name: "clockify_groups_add_member",
  ...GROUP_MEMBERSHIP_API_METADATA.clockify_groups_add_member,
  description:
    "Add one member to a group. Pass the group by `groupId`/`groupName` and the user by `userId`/`userName` (or 'me'). For multiple members use the internal clockify_groups_add_user composite. Elevated write — previews and requires confirmation.",
  group: UG,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: membershipContract,
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
    const group = await resolveEntityRef(
      { id: args.groupId, name: args.groupName },
      { noun: "user group", verb: "add a member to", list: () => ctx.clockify.listGroups() },
    );
    if (!group.ok) return group.clarify;
    const user = await resolveUserRef(
      { id: args.userId, name: args.userName },
      { verb: "add", adminUserId: ctx.adminUserId, listUsers: () => ctx.clockify.listUsers() },
    );
    if (!user.ok) return user.clarify;
    const groupResult = await ctx.clockify.listGroups();
    const groupRow = groupResult.rows.find((row) => row.id === group.id);
    if (!groupRow || groupResult.truncated) return { clarify: "I couldn't obtain complete membership evidence for that group." };
    if ((groupRow.userIds ?? []).includes(user.userId)) {
      return { clarify: "That member is already in the group. Refresh the membership and choose only users to add." };
    }
    const userResult = await ctx.clockify.listUsers();
    const userRow = userResult.rows.find((row) => row.id === user.userId);
    if (!userRow || userResult.truncated) return { clarify: "I couldn't obtain complete evidence for that member." };
    const parentSnapshot = captureTargetSnapshot("parent", { type: "group", id: group.id, name: group.name }, {
      id: groupRow.id,
      name: groupRow.name,
      userIds: [...(groupRow.userIds ?? [])].sort(),
    });
    const targetSnapshot = captureTargetSnapshot("target", { type: "user", id: userRow.id, name: userRow.name }, {
      id: userRow.id,
      name: userRow.name,
      email: userRow.email,
      status: userRow.status,
    });
    return {
      actionLabel: "Add user to group",
      targets: [{ type: "group", id: group.id, name: group.name }],
      expectedChanges: [`Add ${user.label} to group "${group.name ?? group.id}"`],
      reversibility: "You can remove the user from the group afterward.",
      warnings: ["This changes group membership (may affect permissions)."],
      payload: { groupId: group.id, userId: user.userId },
      targetSnapshots: [parentSnapshot, targetSnapshot],
      mutationPlan: {
        mode: "single",
        steps: [{ id: "add-user-to-group", kind: "primary", targetFingerprint: parentSnapshot.fingerprint, reconciliationStrategy: "update" }],
      },
    };
  },
  async commit(ctx, payload, operation) {
    const { groupId, userId } = payload as { groupId: string; userId: string };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "add-user-to-group", name: "Add user to group",
      verification: {
        snapshots: operation.targetSnapshots ?? [],
        async fetchSnapshot(snapshot) {
          if (snapshot.ref.type === "group") {
            const groups = await ctx.clockify.listGroups();
            const row = groups.rows.find((candidate) => candidate.id === snapshot.ref.id);
            return row ? { ref: snapshot.ref, projection: { id: row.id, name: row.name, userIds: [...(row.userIds ?? [])].sort() }, truncated: groups.truncated } : undefined;
          }
          if (snapshot.ref.type === "user") {
            const users = await ctx.clockify.listUsers();
            const row = users.rows.find((candidate) => candidate.id === snapshot.ref.id);
            return row ? { ref: { type: "user", id: row.id, name: row.name }, projection: { id: row.id, name: row.name, email: row.email, status: row.status }, truncated: users.truncated } : undefined;
          }
          return undefined;
        },
      },
      async dispatch() {
        const parent = operation.targetSnapshots?.[0]?.projection as { userIds?: string[] } | undefined;
        const expectedUserIds = [...(parent?.userIds ?? []), userId].sort();
        const dispatched = await dispatchWithReconciliation({
          dispatch: async () => { await ctx.clockify.addUserToGroupAtomic(groupId, userId); return true; },
          reconcile: async () => {
            const groups = await ctx.clockify.listGroups();
            const row = groups.rows.find((candidate) => candidate.id === groupId);
            if (!row || groups.truncated) return undefined;
            const actual = [...(row.userIds ?? [])].sort();
            return JSON.stringify(actual) === JSON.stringify(expectedUserIds) ? true : undefined;
          },
        });
        return { externalId: userId, effect: { groupId, userId, membership: "added" }, detail: { reconciled: dispatched.reconciled, expectedUserIds } };
      },
      success: () => successReceipt({
        action: "clockify_groups_add_member",
        entity: "group",
        ids: { workspaceId: ctx.workspaceId, groupId },
        changed: { updated: [{ type: "group", id: groupId }] },
      }),
    });
  },
});

export const USER_API_ACTIONS: ActionDefinition[] = [
  hourlyRateUpdate,
  costRateUpdate,
  addMember,
];

// Re-export for tests that import rate helpers from users API module.
export {
  previewWorkspaceMemberRate,
  workspaceMemberRateSchema,
  USER_RATE_LITERAL_ALIASES,
  USER_GROUP_API_METADATA,
};
