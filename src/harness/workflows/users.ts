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
  type ConfirmableOperation,
  type RiskyClarifyResult,
  type RiskyPreviewResult,
  type SemanticLiteralAlias,
  type TargetSnapshot,
} from "../action.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { commitSingleDurableRiskyStep, executeDurableRiskyStep } from "../durable-risky-write.js";
import { executeVerifiedMutationStep } from "../verified-mutation-step.js";
import { listReceipt, successReceipt, errorReceipt } from "../receipts.js";
import { captureTargetSnapshot, verifyTargetSnapshots } from "../target-snapshots.js";
import { DefinitiveWriteFailure } from "../../clockify/write-outcome.js";
import { sanitizedFingerprint } from "../safe-json.js";
import { resolveEntityRef, resolveUserRef, resolveUserRefs } from "./resolve.js";
import { RATE_FIELDS, buildRatePreview } from "./rate.js";
import { zNumberLike } from "../arg-shapes.js";
import { toMinor } from "../money.js";
import { dispatchWithReconciliation, reconcileCreate } from "./structure-durable.js";
import type { UserRoleAssignment } from "../../clockify/ports/users.js";
import { bindMutationPlanHostCalls, GROUP_MEMBER_BATCH_MAX } from "../safety-limits.js";
import {
  apiActionMetadataFields,
  type ApiAccess,
  type ApiActionMetadataCarrier,
  type ApiExposure,
  type ApiMethod,
  type AvailabilityByAuthClass,
  type MaterialFieldMetadata,
} from "../api-operation.js";

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

type UserGroupActionName =
  | "clockify_users_list"
  | "clockify_users_invite"
  | "clockify_users_role_update"
  | "clockify_users_rate_update"
  | "clockify_users_hourly_rate_update"
  | "clockify_users_cost_rate_update"
  | "clockify_users_deactivate"
  | "clockify_groups_list"
  | "clockify_groups_get"
  | "clockify_groups_create"
  | "clockify_groups_update"
  | "clockify_groups_delete"
  | "clockify_groups_add_user"
  | "clockify_groups_remove_user";

const USER_GROUP_AVAILABILITY: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: true }),
  api_key: Object.freeze({ available: true }),
});

function userGroupEndpointKey(
  access: ApiAccess,
  method: ApiMethod,
  path: string,
  sourceModule = "users.ts",
): string {
  return [access, "api", method, path, sourceModule].join("\0");
}

function userGroupMaterialField(
  path: string,
  label: string,
  formatterId: string,
  requiredInPreview: boolean,
): MaterialFieldMetadata {
  return Object.freeze({
    kind: "value",
    path,
    label,
    formatterId,
    formatterVersion: 1,
    requiredInPreview,
  });
}

function userGroupApiMetadata(input: {
  actionName: UserGroupActionName;
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
    adapterEndpoints: Object.freeze({
      primary: Object.freeze([input.primary]),
      support: Object.freeze([...input.support]),
    }),
    availabilityByAuthClass: USER_GROUP_AVAILABILITY,
    boundedArgumentDictionaries: Object.freeze([]),
    materialFields: Object.freeze([...input.materialFields]),
    presentation: Object.freeze({ presenterId: input.actionName, version: 1 }),
  });
}

function userGroupInternalMetadata(input: {
  exposure: Exclude<ApiExposure, "api" | "local">;
  reason: string;
  primary: readonly string[];
  support: readonly string[];
}): ApiActionMetadataCarrier {
  return Object.freeze({
    apiExposure: input.exposure,
    apiExposureReason: input.reason,
    adapterEndpoints: Object.freeze({
      primary: Object.freeze([...input.primary]),
      support: Object.freeze([...input.support]),
    }),
    availabilityByAuthClass: USER_GROUP_AVAILABILITY,
    boundedArgumentDictionaries: Object.freeze([]),
  });
}

const userGroupEndpoint = Object.freeze({
  usersList: userGroupEndpointKey("read", "GET", "/workspaces/{workspaceId}/users"),
  usersInvite: userGroupEndpointKey("write", "POST", "/workspaces/{workspaceId}/users"),
  usersRole: userGroupEndpointKey("write", "POST", "/workspaces/{workspaceId}/users/{userId}/roles"),
  usersRate: userGroupEndpointKey("write", "PUT", "/workspaces/{workspaceId}/users/{userId}/{kind}"),
  usersHourlyRate: userGroupEndpointKey("write", "PUT", "/workspaces/{workspaceId}/users/{userId}/hourly-rate"),
  usersCostRate: userGroupEndpointKey("write", "PUT", "/workspaces/{workspaceId}/users/{userId}/cost-rate"),
  usersStatus: userGroupEndpointKey("write", "PUT", "/workspaces/{workspaceId}/users/{userId}"),
  groupsList: userGroupEndpointKey("read", "GET", "/workspaces/{workspaceId}/user-groups"),
  groupsCreate: userGroupEndpointKey("write", "POST", "/workspaces/{workspaceId}/user-groups"),
  groupsUpdate: userGroupEndpointKey("write", "PUT", "/workspaces/{workspaceId}/user-groups/{id}"),
  groupsDelete: userGroupEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/user-groups/{id}"),
  groupsAddUser: userGroupEndpointKey("write", "POST", "/workspaces/{workspaceId}/user-groups/{groupId}/users"),
  groupsRemoveUser: userGroupEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/user-groups/{groupId}/users/{userId}"),
  projectsList: userGroupEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects", "projects.ts"),
  projectsGet: userGroupEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
  workspaceGet: userGroupEndpointKey("read", "GET", "/workspaces/{workspaceId}", "workspace.ts"),
});

const USER_GROUP_API_METADATA = Object.freeze({
  clockify_users_list: userGroupApiMetadata({
    actionName: "clockify_users_list",
    operationId: "getUsersOfWorkspace",
    method: "GET",
    path: "/workspaces/{workspaceId}/users",
    access: "read",
    primary: userGroupEndpoint.usersList,
    support: [],
    materialFields: [],
  }),
  clockify_users_invite: userGroupApiMetadata({
    actionName: "clockify_users_invite",
    operationId: "addUsers",
    method: "POST",
    path: "/workspaces/{workspaceId}/users",
    access: "write",
    primary: userGroupEndpoint.usersInvite,
    support: [userGroupEndpoint.usersList],
    materialFields: [
      userGroupMaterialField("/email", "Email", "text", true),
      userGroupMaterialField("/sendEmail", "Send email", "boolean", true),
    ],
  }),
  clockify_users_role_update: userGroupApiMetadata({
    actionName: "clockify_users_role_update",
    operationId: "createUserRole",
    method: "POST",
    path: "/workspaces/{workspaceId}/users/{userId}/roles",
    access: "write",
    primary: userGroupEndpoint.usersRole,
    support: [
      userGroupEndpoint.usersList,
      userGroupEndpoint.groupsList,
      userGroupEndpoint.projectsList,
      userGroupEndpoint.projectsGet,
      userGroupEndpoint.workspaceGet,
    ],
    materialFields: [
      userGroupMaterialField("/granteeId", "User", "entity", true),
      userGroupMaterialField("/role", "Role", "text", true),
      userGroupMaterialField("/entityId", "Role scope", "entity", true),
      userGroupMaterialField("/sourceType", "Scope type", "text", false),
    ],
  }),
  clockify_users_rate_update: userGroupInternalMetadata({
    exposure: "generic",
    reason: "Selects the hourly-rate or cost-rate endpoint from rateKind; Task 6 must split the dynamic mutation path.",
    primary: [userGroupEndpoint.usersRate],
    support: [userGroupEndpoint.usersList],
  }),
  clockify_users_hourly_rate_update: userGroupApiMetadata({
    actionName: "clockify_users_hourly_rate_update",
    operationId: "setHourlyRateForUser",
    method: "PUT",
    path: "/workspaces/{workspaceId}/users/{userId}/hourly-rate",
    access: "write",
    primary: userGroupEndpoint.usersHourlyRate,
    support: [userGroupEndpoint.usersList],
    materialFields: [
      userGroupMaterialField("/userId", "Member", "entity", true),
      userGroupMaterialField("/amountMinor", "Hourly rate", "money-minor", true),
    ],
  }),
  clockify_users_cost_rate_update: userGroupApiMetadata({
    actionName: "clockify_users_cost_rate_update",
    operationId: "setCostRateForUser",
    method: "PUT",
    path: "/workspaces/{workspaceId}/users/{userId}/cost-rate",
    access: "write",
    primary: userGroupEndpoint.usersCostRate,
    support: [userGroupEndpoint.usersList],
    materialFields: [
      userGroupMaterialField("/userId", "Member", "entity", true),
      userGroupMaterialField("/amountMinor", "Cost rate", "money-minor", true),
    ],
  }),
  clockify_users_deactivate: userGroupApiMetadata({
    actionName: "clockify_users_deactivate",
    operationId: "updateUserStatus",
    method: "PUT",
    path: "/workspaces/{workspaceId}/users/{userId}",
    access: "write",
    primary: userGroupEndpoint.usersStatus,
    support: [userGroupEndpoint.usersList],
    materialFields: [
      userGroupMaterialField("/userId", "User", "entity", true),
    ],
  }),
  clockify_groups_list: userGroupApiMetadata({
    actionName: "clockify_groups_list",
    operationId: "getUserGroups",
    method: "GET",
    path: "/workspaces/{workspaceId}/user-groups",
    access: "read",
    primary: userGroupEndpoint.groupsList,
    support: [],
    materialFields: [],
  }),
  clockify_groups_get: userGroupInternalMetadata({
    exposure: "composite",
    reason: "Finds one user group by scanning the workspace group list because Clockify exposes no GET /user-groups/{id}; it is not a fabricated get-one operation.",
    primary: [userGroupEndpoint.groupsList],
    support: [],
  }),
  clockify_groups_create: userGroupApiMetadata({
    actionName: "clockify_groups_create",
    operationId: "createUserGroup",
    method: "POST",
    path: "/workspaces/{workspaceId}/user-groups",
    access: "write",
    primary: userGroupEndpoint.groupsCreate,
    support: [userGroupEndpoint.groupsList],
    materialFields: [
      userGroupMaterialField("/name", "Group name", "text", true),
    ],
  }),
  clockify_groups_update: userGroupApiMetadata({
    actionName: "clockify_groups_update",
    operationId: "updateUserGroup",
    method: "PUT",
    path: "/workspaces/{workspaceId}/user-groups/{id}",
    access: "write",
    primary: userGroupEndpoint.groupsUpdate,
    support: [userGroupEndpoint.groupsList],
    materialFields: [
      userGroupMaterialField("/id", "Group", "entity", true),
      userGroupMaterialField("/name", "Group name", "text", true),
    ],
  }),
  clockify_groups_delete: userGroupApiMetadata({
    actionName: "clockify_groups_delete",
    operationId: "deleteUserGroup",
    method: "DELETE",
    path: "/workspaces/{workspaceId}/user-groups/{id}",
    access: "write",
    primary: userGroupEndpoint.groupsDelete,
    support: [userGroupEndpoint.groupsList],
    materialFields: [
      userGroupMaterialField("/id", "Group", "entity", true),
      userGroupMaterialField("/name", "Group name", "text", false),
    ],
  }),
  clockify_groups_add_user: userGroupInternalMetadata({
    exposure: "composite",
    reason: "May add up to 14 users through independent membership POSTs; use clockify_groups_add_member for a single-user add.",
    primary: [userGroupEndpoint.groupsAddUser],
    support: [userGroupEndpoint.groupsList, userGroupEndpoint.usersList],
  }),
  clockify_groups_remove_user: userGroupApiMetadata({
    actionName: "clockify_groups_remove_user",
    operationId: "deleteUser",
    method: "DELETE",
    path: "/workspaces/{workspaceId}/user-groups/{groupId}/users/{userId}",
    access: "write",
    primary: userGroupEndpoint.groupsRemoveUser,
    support: [userGroupEndpoint.groupsList, userGroupEndpoint.usersList],
    materialFields: [
      userGroupMaterialField("/groupId", "Group", "entity", true),
      userGroupMaterialField("/userId", "User", "entity", true),
    ],
  }),
} satisfies Readonly<Record<UserGroupActionName, ApiActionMetadataCarrier>>);

export { USER_GROUP_API_METADATA };

const createContract = durableMutationContract({ source: "confirmed", targeting: { mode: "create_no_target" }, strategies: ["create"] });
const userTargetContract = (strategy: "update" | "state-command") => durableMutationContract({
  source: "confirmed", targeting: { mode: "snapshots", relations: ["target"] }, strategies: [strategy],
});
const groupTargetContract = (strategy: "update" | "delete") => durableMutationContract({
  source: "confirmed", targeting: { mode: "snapshots", relations: ["target"] }, strategies: [strategy],
});
const membershipContract = durableMutationContract({
  source: "confirmed", targeting: { mode: "snapshots", relations: ["parent", "target"] }, strategies: ["update"],
});
const roleContract = durableMutationContract({
  source: "confirmed", targeting: { mode: "snapshots", relations: ["target", "parent"] }, strategies: ["state-command"],
});

type UserRow = Awaited<ReturnType<ActionContext["clockify"]["listUsers"]>>["rows"][number];
type GroupRow = Awaited<ReturnType<ActionContext["clockify"]["listGroups"]>>["rows"][number];
const userProjection = (row: UserRow) => ({ id: row.id, name: row.name, email: row.email, status: row.status });
const groupProjection = (row: GroupRow) => ({ id: row.id, name: row.name, userIds: [...(row.userIds ?? [])].sort() });

const normalizedText = (value: string): string => value.normalize("NFKC").trim().toLocaleLowerCase("en-US");

async function requireFreshIds(
  list: () => Promise<{ rows: Array<{ id: string }>; truncated: boolean }>,
  baselineIds: readonly string[],
  label: string,
) {
  const current = await list();
  const ids = current.rows.map((row) => row.id).sort();
  if (current.truncated || sanitizedFingerprint(ids) !== sanitizedFingerprint([...baselineIds].sort())) {
    throw new DefinitiveWriteFailure("VERIFY", `${label}_baseline`, `The ${label} list changed after preview. Create a fresh preview.`);
  }
}

function matchingScopedRoles(rows: readonly UserRoleAssignment[], entityId: string, sourceType?: string) {
  return rows.filter((row) => row.entityId === entityId && row.sourceType === sourceType);
}

async function scopedRoleProjection(ctx: ActionContext, userId: string, entityId: string, sourceType?: string) {
  const [user, roles] = await Promise.all([
    currentUserEvidence(ctx, userId),
    ctx.clockify.listUserRoleAssignments(userId),
  ]);
  if (!user || user.truncated || roles.truncated) return undefined;
  const matches = matchingScopedRoles(roles.rows, entityId, sourceType);
  if (matches.length > 1) return undefined;
  return { ...userProjection(user.row), scopedRole: matches[0] ?? null };
}

async function expectedGroupMembership(ctx: ActionContext, groupId: string, expectedUserIds: readonly string[]) {
  const evidence = await currentGroupEvidence(ctx, groupId);
  if (!evidence || evidence.truncated) return undefined;
  return sanitizedFingerprint([...(evidence.row.userIds ?? [])].sort()) === sanitizedFingerprint([...expectedUserIds].sort())
    ? true
    : undefined;
}

export const USER_RATE_LITERAL_ALIASES = Object.freeze([
  { path: "userId", value: "me", authoredPhrases: Object.freeze(["my", "myself"]) },
] satisfies readonly SemanticLiteralAlias[]);

export const workspaceMemberRateSchema = z
  .object({
    userId: z.string().min(1).optional(),
    userName: z.string().min(1).optional(),
    amount: zNumberLike(z.number().nonnegative()),
    amountUnit: z.enum(["major", "minor"]).default("major"),
    since: z.string().optional(),
  })
  .refine((v) => v.userId !== undefined || v.userName !== undefined, {
    message: "Provide the member (id or exact name, or 'me').",
  });

async function scopedRateProjection(ctx: ActionContext, userId: string, rateKind: "HOURLY" | "COST") {
  const [user, scopedRate] = await Promise.all([
    currentUserEvidence(ctx, userId),
    ctx.clockify.getWorkspaceMemberRate(userId, rateKind),
  ]);
  if (!user || user.truncated || !scopedRate) return undefined;
  return { ...userProjection(user.row), scopedRate };
}

export async function previewWorkspaceMemberRate(
  ctx: ActionContext,
  args: z.infer<typeof workspaceMemberRateSchema>,
  options: {
    rateKind: "HOURLY" | "COST";
    planStepId: string;
    includeRateKindInPayload?: boolean;
  },
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
  const member = await resolveUserRef(
    { id: args.userId, name: args.userName },
    { verb: "set a rate for", adminUserId: ctx.adminUserId, listUsers: () => ctx.clockify.listUsers() },
  );
  if (!member.ok) return member.clarify;
  const userId = member.userId;
  const memberLabel = member.label;
  const evidence = await currentUserEvidence(ctx, userId);
  if (!evidence || evidence.truncated) return { clarify: "I couldn't obtain complete evidence for that workspace member." };
  const currentRate = await ctx.clockify.getWorkspaceMemberRate(userId, options.rateKind);
  if (!currentRate) return { clarify: "I couldn't obtain exact scoped rate evidence for that workspace member." };
  const targetSnapshot = captureTargetSnapshot(
    "target",
    { type: "user", id: userId, name: evidence.row.name },
    { ...userProjection(evidence.row), scopedRate: currentRate },
  );
  const amountMinor = toMinor(args.amount, args.amountUnit);
  return {
    ...buildRatePreview({
      targetType: "user",
      targetId: userId,
      scopeLabel: `for ${memberLabel}`,
      amountMinor,
      rateKind: options.rateKind,
      kindNoun: "member",
    }),
    payload: {
      userId,
      amountMinor,
      ...(options.includeRateKindInPayload ? { rateKind: options.rateKind } : {}),
      ...(args.since !== undefined ? { since: args.since } : {}),
    },
    targetSnapshots: [targetSnapshot],
    mutationPlan: {
      mode: "single" as const,
      steps: [{
        id: options.planStepId,
        kind: "primary",
        targetFingerprint: targetSnapshot.fingerprint,
        reconciliationStrategy: "update",
      }],
    },
  };
}

export async function commitWorkspaceMemberRateStep(
  ctx: ActionContext,
  operation: ConfirmableOperation,
  rateInput: { userId: string; amountMinor: number; since?: string; rateKind?: "HOURLY" | "COST" },
  options: {
    planStepId: string;
    stepName: string;
    actionName: string;
    rateKind: "HOURLY" | "COST";
    dispatch: (input: { userId: string; amountMinor: number; since?: string }) => Promise<void>;
  },
) {
  return commitSingleDurableRiskyStep({
    ctx,
    operation,
    planStepId: options.planStepId,
    name: options.stepName,
    verification: {
      snapshots: operation.targetSnapshots ?? [],
      async fetchSnapshot(snapshot) {
        const projection = await scopedRateProjection(ctx, rateInput.userId, options.rateKind);
        return projection ? { ref: snapshot.ref, projection } : undefined;
      },
    },
    async dispatch() {
      const dispatched = await dispatchWithReconciliation({
        dispatch: async () => {
          await options.dispatch({
            userId: rateInput.userId,
            amountMinor: rateInput.amountMinor,
            ...(rateInput.since !== undefined ? { since: rateInput.since } : {}),
          });
          return true;
        },
        reconcile: async () => {
          const current = await ctx.clockify.getWorkspaceMemberRate(rateInput.userId, options.rateKind);
          if (!current || current.amountMinor !== rateInput.amountMinor) return undefined;
          if (rateInput.since !== undefined && current.since !== rateInput.since) return undefined;
          return true;
        },
      });
      return {
        externalId: rateInput.userId,
        effect: {
          rateKind: options.rateKind,
          amountMinor: rateInput.amountMinor,
          ...(rateInput.since !== undefined ? { since: rateInput.since } : {}),
        },
        detail: { reconciled: dispatched.reconciled },
      };
    },
    success: () => successReceipt({
      action: options.actionName,
      entity: "user",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "user", id: rateInput.userId }] },
    }),
  });
}

async function currentUserEvidence(ctx: ActionContext, id: string) {
  const result = await ctx.clockify.listUsers();
  const row = result.rows.find((candidate) => candidate.id === id);
  return row ? { row, truncated: result.truncated } : undefined;
}

async function currentGroupEvidence(ctx: ActionContext, id: string) {
  const result = await ctx.clockify.listGroups();
  const row = result.rows.find((candidate) => candidate.id === id);
  return row ? { row, truncated: result.truncated } : undefined;
}

async function fetchUserGroupSnapshot(ctx: ActionContext, snapshot: TargetSnapshot) {
  if (snapshot.ref.type === "user") {
    const evidence = await currentUserEvidence(ctx, snapshot.ref.id);
    return evidence ? { ref: snapshot.ref, projection: userProjection(evidence.row), truncated: evidence.truncated } : undefined;
  }
  if (snapshot.ref.type === "group") {
    const evidence = await currentGroupEvidence(ctx, snapshot.ref.id);
    return evidence ? { ref: snapshot.ref, projection: groupProjection(evidence.row), truncated: evidence.truncated } : undefined;
  }
  if (snapshot.ref.type === "project") {
    const project = await ctx.clockify.getProject(snapshot.ref.id);
    return project ? { ref: snapshot.ref, projection: project } : undefined;
  }
  if (snapshot.ref.type === "workspace") {
    const workspace = await ctx.clockify.getWorkspace();
    return { ref: snapshot.ref, projection: workspace };
  }
  return undefined;
}

// ── Users ───────────────────────────────────────────────────────────────────

const listUsers = defineReadAction({
  name: "clockify_users_list",
  ...USER_GROUP_API_METADATA.clockify_users_list,
  description: "List workspace users.",
  group: UG,
  schema: z.object({}),
  async handler(ctx) {
    const { rows, truncated } = await ctx.clockify.listUsers();
    return listReceipt({ action: "clockify_users_list", entity: "user", ids: { workspaceId: ctx.workspaceId }, rows, truncated });
  },
});

const inviteUser = defineRiskyAction({
  name: "clockify_users_invite",
  ...USER_GROUP_API_METADATA.clockify_users_invite,
  description: "Invite a user to the workspace by email. External side effect (may email) — previews and requires confirmation. Email is NOT sent unless sendEmail is true.",
  group: UG,
  risks: ["external_side_effect"],
  mutationWorkflow: "durable",
  mutationContract: createContract,
  semanticLiteralAliases: Object.freeze([
    { path: "sendEmail", value: false, authoredPhrases: Object.freeze(["do not send email", "don't send email", "without email", "no email"]) },
    { path: "sendEmail", value: true, authoredPhrases: Object.freeze(["send email", "send an email"]) },
  ] satisfies readonly SemanticLiteralAlias[]),
  schema: z.object({ email: z.string().email(), sendEmail: z.boolean().default(false) }),
  async preview(ctx, args) {
    const baseline = await ctx.clockify.listUsers();
    if (baseline.truncated) return { clarify: "Clockify returned an incomplete user list, so I can't safely invite or reconcile this address." };
    if (baseline.rows.some((row) => row.email?.toLocaleLowerCase("en-US") === args.email.toLocaleLowerCase("en-US"))) {
      return { clarify: `${args.email} is already present in this workspace.` };
    }
    return {
      actionLabel: "Invite user",
      targets: [],
      expectedChanges: [`Invite ${args.email} to the workspace${args.sendEmail ? " (send email)" : " (no email)"}`],
      reversibility: "You can deactivate the user afterward.",
      warnings: [args.sendEmail ? "This adds a user and emails them an invitation." : "This adds a user to the workspace."],
      payload: {
        email: args.email, sendEmail: args.sendEmail, baselineIds: baseline.rows.map((row) => row.id).sort(),
        finalFingerprint: sanitizedFingerprint({ email: args.email.toLocaleLowerCase("en-US") }),
      },
      mutationPlan: { mode: "single", steps: [{ id: "invite-user", kind: "primary", reconciliationStrategy: "create" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { email, sendEmail, baselineIds, finalFingerprint } = payload as { email: string; sendEmail: boolean; baselineIds: string[]; finalFingerprint: string };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "invite-user", name: "Invite user",
      async dispatch() {
        await requireFreshIds(() => ctx.clockify.listUsers(), baselineIds, "user");
        const dispatched = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.inviteUserAtomic(email, sendEmail),
          reconcile: async () => {
            const row = await reconcileCreate({
              beforeIds: baselineIds,
              list: () => ctx.clockify.listUsers(),
              matches: (candidate) => sanitizedFingerprint({ email: normalizedText(candidate.email ?? "") }) === finalFingerprint,
            });
            return row ? { id: row.id, name: row.name } : undefined;
          },
        });
        const user = dispatched.value;
        return { externalId: user.id, effect: { created: { type: "user", id: user.id, name: user.name } }, detail: { reconciled: dispatched.reconciled } };
      },
      success: (step) => successReceipt({ action: "clockify_users_invite", entity: "user", ids: { workspaceId: ctx.workspaceId }, changed: { created: [{ type: "user", id: step.externalId ?? email, name: email }] } }),
    });
  },
});

const updateRole = defineRiskyAction({
  name: "clockify_users_role_update",
  ...USER_GROUP_API_METADATA.clockify_users_role_update,
  description:
    "Give a workspace member a manager role; the SCOPE depends on the role (live-verified): WORKSPACE_ADMIN = the whole workspace (no scope needed); PROJECT_MANAGER = a project (pass `projectId` or exact `projectName`); TEAM_MANAGER = a user group (pass `groupId` or exact `groupName`). Pass the RECIPIENT by `userId`/`userName` (or 'me'). Elevated write — previews and requires confirmation.",
  group: UG,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: roleContract,
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
    })
    .superRefine((value, refinement) => {
      const hasProjectScope = value.projectId !== undefined || value.projectName !== undefined;
      const hasGroupScope = value.groupId !== undefined || value.groupName !== undefined;
      if (value.role === "PROJECT_MANAGER" && hasGroupScope) {
        refinement.addIssue({ code: "custom", path: ["groupId"], message: "PROJECT_MANAGER accepts only a project scope." });
      }
      if (value.role === "TEAM_MANAGER" && hasProjectScope) {
        refinement.addIssue({ code: "custom", path: ["projectId"], message: "TEAM_MANAGER accepts only a user-group scope." });
      }
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
    const userEvidence = await currentUserEvidence(ctx, granteeId);
    if (!userEvidence || userEvidence.truncated) return { clarify: "I couldn't obtain complete evidence for that workspace member." };

    // 2) SCOPE (entityId) — live-verified contract: WORKSPACE_ADMIN = workspaceId
    // (no sourceType); a group = the group id + sourceType USER_GROUP (TEAM_MANAGER);
    // a project = the project id, no sourceType (PROJECT_MANAGER only).
    let entityId: string;
    let sourceType: string | undefined;
    let scopeLabel: string;
    let parentSnapshot: TargetSnapshot;
    if (args.role === "WORKSPACE_ADMIN") {
      entityId = ctx.workspaceId;
      scopeLabel = "the whole workspace";
      const workspace = await ctx.clockify.getWorkspace();
      parentSnapshot = captureTargetSnapshot("parent", { type: "workspace", id: ctx.workspaceId }, workspace);
    } else if (args.groupId || args.groupName) {
      const group = await resolveEntityRef(
        { id: args.groupId, name: args.groupName },
        { noun: "user group", verb: "manage", list: () => ctx.clockify.listGroups(), verifyId: true },
      );
      if (!group.ok) return group.clarify;
      entityId = group.id;
      sourceType = "USER_GROUP";
      scopeLabel = `the "${group.name}" group`;
      const currentGroup = await currentGroupEvidence(ctx, group.id);
      if (!currentGroup || currentGroup.truncated) return { clarify: "I couldn't obtain complete evidence for that user group." };
      parentSnapshot = captureTargetSnapshot("parent", { type: "group", id: group.id, name: group.name }, groupProjection(currentGroup.row));
    } else if (args.projectId || args.projectName) {
      const project = await resolveEntityRef(
        { id: args.projectId, name: args.projectName },
        { noun: "project", verb: "manage", list: () => ctx.clockify.listProjects(), verifyId: true },
      );
      if (!project.ok) return project.clarify;
      entityId = project.id;
      scopeLabel = `the "${project.name}" project`;
      const currentProject = await ctx.clockify.getProject(project.id);
      if (!currentProject) return { clarify: "I couldn't verify that project scope." };
      parentSnapshot = captureTargetSnapshot("parent", { type: "project", id: project.id, name: project.name }, currentProject);
    } else {
      return { clarify: `Which ${args.role === "TEAM_MANAGER" ? "user group" : "project"} should ${granteeName} manage as ${args.role}? Give me its exact name.` };
    }

    const roleEvidence = await ctx.clockify.listUserRoleAssignments(granteeId);
    if (roleEvidence.truncated) return { clarify: "I couldn't obtain complete scoped role evidence for that workspace member." };
    const existingRoles = matchingScopedRoles(roleEvidence.rows, entityId, sourceType);
    if (existingRoles.length > 1) return { clarify: "Clockify returned ambiguous scoped role evidence for that member." };
    const roleTargetSnapshot = captureTargetSnapshot(
      "target",
      { type: "user", id: granteeId, name: userEvidence.row.name },
      { ...userProjection(userEvidence.row), scopedRole: existingRoles[0] ?? null },
    );
    return {
      actionLabel: "Update user role",
      targets: [{ type: "user", id: granteeId }],
      expectedChanges: [`Make ${granteeName} a ${args.role} for ${scopeLabel}`],
      reversibility: "You can change the role again.",
      warnings: ["This changes a user's workspace permissions."],
      payload: { granteeId, role: args.role, entityId, ...(sourceType !== undefined ? { sourceType } : {}) },
      targetSnapshots: [roleTargetSnapshot, parentSnapshot],
      mutationPlan: { mode: "single", steps: [{ id: "update-user-role", kind: "primary", targetFingerprint: roleTargetSnapshot.fingerprint, reconciliationStrategy: "state-command" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { granteeId, role, entityId, sourceType } = payload as { granteeId: string; role: string; entityId: string; sourceType?: string };
    // POST /users/{recipient}/roles {entityId: scope, role, sourceType?} — recipient
    // in the URL, scope (workspace/project/group) in entityId. Live-verified 2026-06-12.
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "update-user-role", name: "Update user role",
      verification: {
        snapshots: operation.targetSnapshots ?? [],
        async fetchSnapshot(snapshot) {
          if (snapshot.ref.type !== "user") return fetchUserGroupSnapshot(ctx, snapshot);
          const projection = await scopedRoleProjection(ctx, granteeId, entityId, sourceType);
          return projection ? { ref: snapshot.ref, projection } : undefined;
        },
      },
      async dispatch() {
        const dispatched = await dispatchWithReconciliation({
          dispatch: async () => { await ctx.clockify.updateUserRoleAtomic(granteeId, role, entityId, sourceType); return true; },
          reconcile: async () => {
            const roles = await ctx.clockify.listUserRoleAssignments(granteeId);
            if (roles.truncated) return undefined;
            const matches = matchingScopedRoles(roles.rows, entityId, sourceType);
            return matches.length === 1 && matches[0]!.role === role ? true : undefined;
          },
        });
        return { externalId: granteeId, effect: { role, entityId, ...(sourceType !== undefined ? { sourceType } : {}) }, detail: { reconciled: dispatched.reconciled } };
      },
      success: () => successReceipt({ action: "clockify_users_role_update", entity: "user", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "user", id: granteeId, name: role }] } }),
    });
  },
});

const rateUpdate = defineRiskyAction({
  name: "clockify_users_rate_update",
  ...USER_GROUP_API_METADATA.clockify_users_rate_update,
  description:
    'Set a workspace member\'s default billable hourly or cost rate — the rate shown in the Team section (distinct from a per-project member rate). Pass the member by `userId`/`userName` (or "me"). `amount` is major units (e.g. 75 = 75.00) unless `amountUnit` is \'minor\'. Billing action — previews and requires confirmation.',
  group: "invoices",
  risks: ["billing"],
  mutationWorkflow: "durable",
  mutationContract: userTargetContract("update"),
  schema: z
    .object({
      /** The member's user id, exact name (via userName), or "me" (resolved server-side). */
      userId: z.string().min(1).optional(),
      userName: z.string().min(1).optional(),
      ...RATE_FIELDS,
    })
    .refine((v) => v.userId !== undefined || v.userName !== undefined, { message: "Provide the member (id or exact name, or 'me')." }),
  async preview(ctx, args) {
    return previewWorkspaceMemberRate(ctx, args, {
      rateKind: args.rateKind,
      planStepId: "update-user-rate",
      includeRateKindInPayload: true,
    });
  },
  async commit(ctx, payload, operation) {
    const rate = payload as { userId: string; rateKind: "HOURLY" | "COST"; amountMinor: number; since?: string };
    return commitWorkspaceMemberRateStep(ctx, operation, rate, {
      planStepId: "update-user-rate",
      stepName: "Update user rate",
      actionName: "clockify_users_rate_update",
      rateKind: rate.rateKind,
      dispatch: (input) => ctx.clockify.updateWorkspaceMemberRateAtomic({ ...input, rateKind: rate.rateKind }),
    });
  },
});

// Self-deactivation guard returns an ERROR receipt from the handler (not a clarify),
// which the risky preview/commit shape cannot express — so this stays a hand-rolled
// defineAction to keep the guard byte-identical.
const deactivateUser = defineAction({
  name: "clockify_users_deactivate",
  ...apiActionMetadataFields(USER_GROUP_API_METADATA.clockify_users_deactivate),
  description:
    "Deactivate a workspace user (removes their access). Pass the member by `userId`/`userName` — an id or the exact name, resolved + verified server-side. Elevated write — previews and requires confirmation.",
  featureGroup: UG,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: userTargetContract("state-command"),
  schema: z
    .object({
      userId: z.string().min(1).optional(),
      userName: z.string().min(1).optional(),
    })
    .refine((v) => v.userId !== undefined || v.userName !== undefined, {
      message: "Provide the member (id or exact name).",
    }),
  referenceSelector: {
    entityType: "user",
    bindings: [{ referenceField: "externalId", argumentPath: "/userId" }],
  },
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
    const evidence = await currentUserEvidence(ctx, member.userId);
    if (!evidence || evidence.truncated) return { kind: "clarify", message: "I couldn't obtain complete evidence for that workspace member." };
    const targetSnapshot = captureTargetSnapshot("target", { type: "user", id: member.userId, name: evidence.row.name }, userProjection(evidence.row));
    const payload = { userId: member.userId, previousStatus: evidence.row.status };
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
      operation: {
        operationId: randomUUID(), actionName: "clockify_users_deactivate", featureGroup: UG, risks: ["high_risk_write"],
        payload, targetSnapshots: [targetSnapshot],
        mutationPlan: bindMutationPlanHostCalls("clockify_users_deactivate", payload, {
          mode: "single",
          steps: [{ id: "deactivate-user", kind: "primary", targetFingerprint: targetSnapshot.fingerprint, reconciliationStrategy: "state-command" }],
        }),
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { userId: string };
    // Re-check the self-deactivation guard at commit (policy is re-checked too).
    if (payload.userId === ctx.adminUserId) {
      return errorReceipt({ action: "clockify_users_deactivate", code: "invalid_args", message: "Refusing to deactivate yourself." });
    }
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "deactivate-user", name: "Deactivate user",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchUserGroupSnapshot(ctx, snapshot) },
      async dispatch() {
        const dispatched = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.deactivateUserAtomic(payload.userId),
          reconcile: async () => {
            const evidence = await currentUserEvidence(ctx, payload.userId);
            return evidence && !evidence.truncated && evidence.row.status === "INACTIVE"
              ? { id: evidence.row.id, name: "INACTIVE" }
              : undefined;
          },
        });
        return { externalId: dispatched.value.id, effect: { previousStatus: (payload as { previousStatus?: string }).previousStatus, status: "INACTIVE" }, detail: { reconciled: dispatched.reconciled } };
      },
      success: (step) => successReceipt({ action: "clockify_users_deactivate", entity: "user", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "user", id: step.externalId ?? payload.userId, name: "INACTIVE" }] } }),
    });
  },
});

// ── Groups ──────────────────────────────────────────────────────────────────

const listGroups = defineReadAction({
  name: "clockify_groups_list",
  ...USER_GROUP_API_METADATA.clockify_groups_list,
  description: "List user groups.",
  group: UG,
  schema: z.object({}),
  async handler(ctx) {
    const { rows, truncated } = await ctx.clockify.listGroups();
    return listReceipt({ action: "clockify_groups_list", entity: "group", ids: { workspaceId: ctx.workspaceId }, rows, truncated });
  },
});

const getGroup = defineAction({
  name: "clockify_groups_get",
  ...USER_GROUP_API_METADATA.clockify_groups_get,
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
  ...USER_GROUP_API_METADATA.clockify_groups_create,
  description: "Create a user group. Elevated write — previews and requires confirmation.",
  group: UG,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: createContract,
  schema: z.object({ name: z.string().min(1) }),
  async preview(ctx, args) {
    const baseline = await ctx.clockify.listGroups();
    if (baseline.truncated) return { clarify: "Clockify returned an incomplete group list, so I can't safely create or reconcile this group." };
    if (baseline.rows.some((row) => row.name?.normalize("NFKC").toLocaleLowerCase("en-US") === args.name.normalize("NFKC").toLocaleLowerCase("en-US"))) {
      return { clarify: `A user group named "${args.name}" already exists.` };
    }
    return {
      actionLabel: "Create user group",
      targets: [],
      expectedChanges: [`Create user group "${args.name}"`],
      reversibility: "You can delete the group afterward.",
      warnings: ["This adds a user group to the workspace."],
      payload: {
        name: args.name, baselineIds: baseline.rows.map((row) => row.id).sort(),
        finalFingerprint: sanitizedFingerprint({ name: args.name.normalize("NFKC").toLocaleLowerCase("en-US") }),
      },
      mutationPlan: { mode: "single", steps: [{ id: "create-group", kind: "primary", reconciliationStrategy: "create" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { name, baselineIds, finalFingerprint } = payload as { name: string; baselineIds: string[]; finalFingerprint: string };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "create-group", name: "Create group",
      async dispatch() {
        await requireFreshIds(() => ctx.clockify.listGroups(), baselineIds, "group");
        const dispatched = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.createGroupAtomic(name),
          reconcile: async () => {
            const row = await reconcileCreate({
              beforeIds: baselineIds,
              list: () => ctx.clockify.listGroups(),
              matches: (candidate) => sanitizedFingerprint({ name: normalizedText(candidate.name) }) === finalFingerprint,
            });
            return row ? { id: row.id, name: row.name } : undefined;
          },
        });
        const group = dispatched.value;
        return { externalId: group.id, effect: { created: { type: "group", id: group.id, name: group.name } }, detail: { reconciled: dispatched.reconciled } };
      },
      success: (step) => successReceipt({ action: "clockify_groups_create", entity: "group", ids: { workspaceId: ctx.workspaceId }, changed: { created: [{ type: "group", id: step.externalId ?? name, name }] } }),
    });
  },
});

const updateGroup = defineRiskyAction({
  name: "clockify_groups_update",
  ...USER_GROUP_API_METADATA.clockify_groups_update,
  description: "Rename a user group. Elevated write — previews and requires confirmation.",
  group: UG,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: groupTargetContract("update"),
  schema: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  async preview(ctx, args) {
    const evidence = await currentGroupEvidence(ctx, args.id);
    if (!evidence || evidence.truncated) return { clarify: `I couldn't verify user group ${args.id}. Give me a current group id.` };
    const targetSnapshot = captureTargetSnapshot("target", { type: "group", id: evidence.row.id, name: evidence.row.name }, groupProjection(evidence.row));
    return {
      actionLabel: "Update user group",
      targets: [{ type: "group", id: args.id, name: args.name }],
      expectedChanges: [`Rename group to "${args.name}"`],
      reversibility: "You can rename the group again.",
      warnings: ["This changes a workspace user group."],
      payload: { id: evidence.row.id, name: args.name },
      targetSnapshots: [targetSnapshot],
      mutationPlan: { mode: "single", steps: [{ id: "update-group", kind: "primary", targetFingerprint: targetSnapshot.fingerprint, reconciliationStrategy: "update" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { id, name } = payload as { id: string; name: string };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "update-group", name: "Update group",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchUserGroupSnapshot(ctx, snapshot) },
      async dispatch() {
        const dispatched = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.updateGroupAtomic(id, name),
          reconcile: async () => {
            const evidence = await currentGroupEvidence(ctx, id);
            return evidence && !evidence.truncated && evidence.row.name === name
              ? { id: evidence.row.id, name: evidence.row.name }
              : undefined;
          },
        });
        const group = dispatched.value;
        return { externalId: group.id, effect: { updated: { type: "group", id: group.id, name: group.name } }, detail: { reconciled: dispatched.reconciled } };
      },
      success: (step) => successReceipt({ action: "clockify_groups_update", entity: "group", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "group", id: step.externalId ?? id, name }] } }),
    });
  },
});

const deleteGroup = defineRiskyAction({
  name: "clockify_groups_delete",
  ...USER_GROUP_API_METADATA.clockify_groups_delete,
  description:
    "Delete a user group. Pass the group id, or its exact `name` and the harness resolves it. Destructive — previews and requires confirmation.",
  group: UG,
  risks: ["destructive"],
  mutationWorkflow: "durable",
  mutationContract: groupTargetContract("delete"),
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
    const evidence = await currentGroupEvidence(ctx, resolved.id);
    if (!evidence || evidence.truncated) return { clarify: `I couldn't verify user group ${resolved.id}. Refresh the group list and try again.` };
    const targetSnapshot = captureTargetSnapshot("target", { type: "group", id: evidence.row.id, name: evidence.row.name }, groupProjection(evidence.row));
    return {
      actionLabel: "Delete user group",
      targets: [{ type: "group", id: resolved.id, name }],
      expectedChanges: [`Delete user group ${name ?? resolved.id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting a group removes its membership grouping."],
      payload: { id: resolved.id, ...(name !== undefined ? { name } : {}) },
      targetSnapshots: [targetSnapshot],
      mutationPlan: { mode: "single", steps: [{ id: "delete-group", kind: "primary", targetFingerprint: targetSnapshot.fingerprint, reconciliationStrategy: "delete" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { id, name } = payload as { id: string; name?: string };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "delete-group", name: "Delete group",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchUserGroupSnapshot(ctx, snapshot) },
      async dispatch() {
        const dispatched = await dispatchWithReconciliation({
          dispatch: async () => { await ctx.clockify.deleteGroupAtomic(id); return true; },
          reconcile: async () => {
            const groups = await ctx.clockify.listGroups();
            return !groups.truncated && !groups.rows.some((row) => row.id === id) ? true : undefined;
          },
        });
        return { externalId: id, effect: { deleted: { type: "group", id, name } }, detail: { reconciled: dispatched.reconciled } };
      },
      success: () => successReceipt({ action: "clockify_groups_delete", entity: "group", ids: { workspaceId: ctx.workspaceId }, changed: { deleted: [{ type: "group", id, name }] } }),
    });
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

function partialGroupAdd(
  ctx: ActionContext,
  groupId: string,
  succeededUserIds: readonly string[],
  total: number,
  reason: "stale" | "definitive" | "ambiguous" | "reconciled",
) {
  const uncertain = reason === "ambiguous"
    ? " The next membership add may or may not have applied."
    : reason === "reconciled"
      ? " The last add was proven successful after an ambiguous response, so no later mutation was sent."
    : reason === "stale"
      ? " The group changed before the next add, so no later mutation was sent."
      : " Clockify definitively rejected the next add.";
  return {
    kind: "partial" as const,
    receipt: successReceipt({
      action: "clockify_groups_add_user",
      entity: "group",
      ids: { workspaceId: ctx.workspaceId, groupId },
      changed: { updated: succeededUserIds.map((id) => ({ type: "group_membership", id })) },
      warnings: reason === "ambiguous" ? [{ code: "outcome_unknown", message: "A later membership add has an unknown outcome." }] : undefined,
    }),
    message: `${succeededUserIds.length} of ${total} group membership additions are known to have succeeded.${uncertain}`,
    recovery: { hint: "Refresh the complete group membership before deciding what remains to add.", retryable: false },
  };
}

const addUser = defineRiskyAction({
  name: "clockify_groups_add_user",
  ...USER_GROUP_API_METADATA.clockify_groups_add_user,
  description:
    "Add one or more members to a group. Pass the group by `groupId`/`groupName` and the members by `members` (an array where each entry is a user id, exact name, or 'me'); a single `userId`/`userName` is also accepted. The harness resolves names server-side and clarifies on an unknown one. Elevated write — previews ALL the adds as ONE card and requires confirmation.",
  group: UG,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: membershipContract,
  schema: z
    .object({
      groupId: z.string().min(1).optional(),
      groupName: z.string().min(1).optional(),
      /** Members to add: user ids, exact names, or 'me' (resolved + verified server-side). */
      members: zStringList(z.array(z.string().min(1)).max(GROUP_MEMBER_BATCH_MAX)).optional(),
      // Single-member shape, tolerated because the planner emits both.
      userId: z.string().min(1).optional(),
      userName: z.string().min(1).optional(),
    })
    .refine((v) => v.groupId !== undefined || v.groupName !== undefined, { message: "Provide the group id or its exact name." })
    .refine((v) => (v.members?.length ?? 0) > 0 || v.userId !== undefined || v.userName !== undefined, {
      message: "Provide at least one member (id, exact name, or 'me').",
    })
    .refine((v) => (v.members?.length ?? 0) + (v.userId ? 1 : 0) + (v.userName ? 1 : 0) <= GROUP_MEMBER_BATCH_MAX, {
      message: `Provide at most ${GROUP_MEMBER_BATCH_MAX} member selectors across members, userId, and userName.`,
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
    const userIds = [...new Set(members.userIds)];
    const groupEvidence = await currentGroupEvidence(ctx, group.id);
    if (!groupEvidence || groupEvidence.truncated) return { clarify: "I couldn't obtain complete membership evidence for that group." };
    if (userIds.some((id) => (groupEvidence.row.userIds ?? []).includes(id))) {
      return { clarify: "At least one selected member is already in that group. Refresh the membership and choose only users to add." };
    }
    const userEvidence = await ctx.clockify.listUsers();
    if (userEvidence.truncated) return { clarify: "I couldn't obtain complete evidence for the selected members." };
    const targetRows = userIds.map((id) => userEvidence.rows.find((row) => row.id === id));
    if (targetRows.some((row) => !row)) return { clarify: "At least one selected member could not be verified." };
    const snapshots: TargetSnapshot[] = [];
    const expectedMembers = [...(groupEvidence.row.userIds ?? [])];
    for (const row of targetRows as UserRow[]) {
      snapshots.push(captureTargetSnapshot("parent", { type: "group", id: group.id, name: group.name }, {
        ...groupProjection(groupEvidence.row), userIds: [...expectedMembers].sort(),
      }));
      snapshots.push(captureTargetSnapshot("target", { type: "user", id: row.id, name: row.name }, userProjection(row)));
      expectedMembers.push(row.id);
    }
    const many = userIds.length > 1;
    return {
      actionLabel: many ? "Add users to group" : "Add user to group",
      targets: [{ type: "group", id: group.id, name: group.name }],
      expectedChanges: [`Add ${members.labels.join(", ")} to group "${group.name ?? group.id}"`],
      reversibility: "You can remove the user from the group afterward.",
      warnings: ["This changes group membership (may affect permissions)."],
      payload: { groupId: group.id, userIds },
      targetSnapshots: snapshots,
      mutationPlan: {
        mode: userIds.length > 1 ? "batch" : "single",
        steps: userIds.map((_, index) => ({
          id: `add-user-to-group-${index}`, kind: "primary" as const,
          targetFingerprint: snapshots[index * 2]!.fingerprint, reconciliationStrategy: "update" as const,
        })),
      },
    };
  },
  async commit(ctx, payload, operation) {
    const { groupId, userIds } = payload as { groupId: string; userIds: string[] };
    const succeededUserIds: string[] = [];
    for (const [index, userId] of userIds.entries()) {
      const planStep = operation.mutationPlan?.steps[index];
      const selected = (operation.targetSnapshots ?? []).slice(index * 2, index * 2 + 2);
      let stale: "stale_target" | "stale_parent" | undefined;
      let reconciled = false;
      const dispatch = async () => {
        const parent = selected[0]?.projection as { userIds?: string[] } | undefined;
        const expectedUserIds = [...(parent?.userIds ?? []), userId].sort();
        const dispatched = await dispatchWithReconciliation({
          dispatch: async () => { await ctx.clockify.addUserToGroupAtomic(groupId, userId); return true; },
          reconcile: () => expectedGroupMembership(ctx, groupId, expectedUserIds),
        });
        reconciled = dispatched.reconciled;
        return { externalId: userId, effect: { groupId, userId, membership: "added" }, detail: { reconciled: dispatched.reconciled, expectedUserIds } };
      };
      const step = ctx.mutationJournal
        ? (await executeVerifiedMutationStep({
            journal: ctx.mutationJournal, operationId: operation.operationId,
            step: {
              id: `add-user-to-group-${index}`, index, name: "Add user to group", kind: "primary",
              ...(planStep?.targetFingerprint ? { targetFingerprint: planStep.targetFingerprint } : {}),
            },
            snapshots: selected, fetchSnapshot: (snapshot) => fetchUserGroupSnapshot(ctx, snapshot), dispatch,
          }).then((result) => { if (!result.verification.ok) stale = result.verification.code; return result.step; }))
        : await executeDurableRiskyStep({
            ctx, operation, planStepId: `add-user-to-group-${index}`, index, name: "Add user to group",
            dispatch: async () => {
              const verified = await verifyTargetSnapshots(selected, (snapshot) => fetchUserGroupSnapshot(ctx, snapshot));
              if (!verified.ok) { stale = verified.code; throw new DefinitiveWriteFailure("VERIFY", groupId, verified.code); }
              return dispatch();
            },
          });
      if (stale) {
        if (succeededUserIds.length > 0) return partialGroupAdd(ctx, groupId, succeededUserIds, userIds.length, "stale");
        return errorReceipt({ action: "clockify_groups_add_user", code: stale, message: "The group membership changed. No further Clockify mutation was sent.", recovery: { hint: "Refresh the group and create a fresh preview.", retryable: true } });
      }
      if (step.status === "succeeded") {
        succeededUserIds.push(userId);
        if (reconciled && succeededUserIds.length < userIds.length) {
          return partialGroupAdd(ctx, groupId, succeededUserIds, userIds.length, "reconciled");
        }
        continue;
      }
      if (step.status === "outcome_unknown") {
        if (succeededUserIds.length > 0) return partialGroupAdd(ctx, groupId, succeededUserIds, userIds.length, "ambiguous");
        return errorReceipt({ action: "clockify_groups_add_user", code: "commit_outcome_unknown", message: "A group membership add may or may not have been applied.", recovery: { hint: "Verify the group membership in Clockify before retrying.", retryable: false } });
      }
      if (succeededUserIds.length > 0) return partialGroupAdd(ctx, groupId, succeededUserIds, userIds.length, "definitive");
      return errorReceipt({ action: "clockify_groups_add_user", code: "write_failed", message: "Clockify rejected the group membership add.", recovery: { hint: "Refresh the group and preview again.", retryable: true } });
    }
    return successReceipt({ action: "clockify_groups_add_user", entity: "group", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "group", id: groupId }] } });
  },
});

const removeUser = defineRiskyAction({
  name: "clockify_groups_remove_user",
  ...USER_GROUP_API_METADATA.clockify_groups_remove_user,
  description:
    "Remove a user from a group. Pass the group by `groupId`/`groupName` and the user by `userId`/`userName` (or 'me') — the harness resolves names server-side and clarifies on an unknown one. Destructive — previews and requires confirmation.",
  group: UG,
  risks: ["destructive"],
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
    const group = await resolveGroupRef(ctx, args, "remove a member from");
    if (!group.ok) return group.clarify;
    const user = await resolveUserRef(
      { id: args.userId, name: args.userName },
      { verb: "remove", adminUserId: ctx.adminUserId, listUsers: () => ctx.clockify.listUsers() },
    );
    if (!user.ok) return user.clarify;
    const groupEvidence = await currentGroupEvidence(ctx, group.id);
    if (!groupEvidence || groupEvidence.truncated) return { clarify: "I couldn't obtain complete membership evidence for that group." };
    const userEvidence = await currentUserEvidence(ctx, user.userId);
    if (!userEvidence || userEvidence.truncated) return { clarify: "I couldn't obtain complete evidence for that member." };
    const parentSnapshot = captureTargetSnapshot("parent", { type: "group", id: group.id, name: group.name }, groupProjection(groupEvidence.row));
    const targetSnapshot = captureTargetSnapshot("target", { type: "user", id: user.userId, name: userEvidence.row.name }, userProjection(userEvidence.row));
    return {
      actionLabel: "Remove user from group",
      targets: [{ type: "group", id: group.id, name: group.name }],
      expectedChanges: [`Remove ${user.label} from group "${group.name ?? group.id}"`],
      reversibility: "You can re-add the user to the group.",
      warnings: ["This changes group membership (may affect permissions)."],
      payload: { groupId: group.id, userId: user.userId },
      targetSnapshots: [parentSnapshot, targetSnapshot],
      mutationPlan: { mode: "single", steps: [{ id: "remove-user-from-group", kind: "primary", targetFingerprint: parentSnapshot.fingerprint, reconciliationStrategy: "update" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { groupId, userId } = payload as { groupId: string; userId: string };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "remove-user-from-group", name: "Remove user from group",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchUserGroupSnapshot(ctx, snapshot) },
      async dispatch() {
        const parent = operation.targetSnapshots?.[0]?.projection as { userIds?: string[] } | undefined;
        const expectedUserIds = (parent?.userIds ?? []).filter((id) => id !== userId).sort();
        const dispatched = await dispatchWithReconciliation({
          dispatch: async () => { await ctx.clockify.removeUserFromGroupAtomic(groupId, userId); return true; },
          reconcile: () => expectedGroupMembership(ctx, groupId, expectedUserIds),
        });
        return { externalId: userId, effect: { groupId, userId, membership: "removed" }, detail: { reconciled: dispatched.reconciled, expectedUserIds } };
      },
      success: () => successReceipt({ action: "clockify_groups_remove_user", entity: "group", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "group", id: groupId }] } }),
    });
  },
});

export function defineWorkspaceMemberRateAction(input: {
  name: "clockify_users_hourly_rate_update" | "clockify_users_cost_rate_update";
  metadataKey: "clockify_users_hourly_rate_update" | "clockify_users_cost_rate_update";
  rateKind: "HOURLY" | "COST";
  planStepId: string;
  stepName: string;
  rateLabel: "hourly" | "cost";
  dispatchKey: "updateWorkspaceMemberHourlyRateAtomic" | "updateWorkspaceMemberCostRateAtomic";
}): ActionDefinition {
  return defineRiskyAction({
    name: input.name,
    ...USER_GROUP_API_METADATA[input.metadataKey],
    description:
      `Set a workspace member's default ${input.rateLabel} rate — the rate shown in the Team section (distinct from a per-project member rate). Pass the member by \`userId\`/\`userName\` (or "me"). \`amount\` is major units (e.g. 75 = 75.00) unless \`amountUnit\` is 'minor'. Billing action — previews and requires confirmation.`,
    group: "invoices",
    risks: ["billing"],
    mutationWorkflow: "durable",
    mutationContract: userTargetContract("update"),
    semanticLiteralAliases: USER_RATE_LITERAL_ALIASES,
    schema: workspaceMemberRateSchema,
    preview: (ctx, args) => previewWorkspaceMemberRate(ctx, args, {
      rateKind: input.rateKind,
      planStepId: input.planStepId,
    }),
    commit: (ctx, payload, operation) => commitWorkspaceMemberRateStep(
      ctx,
      operation,
      payload as { userId: string; amountMinor: number; since?: string },
      {
        planStepId: input.planStepId,
        stepName: input.stepName,
        actionName: input.name,
        rateKind: input.rateKind,
        dispatch: (rateInput) => ctx.clockify[input.dispatchKey](rateInput),
      },
    ),
  });
}

export const USER_GROUP_ACTIONS: ActionDefinition[] = [
  listUsers, inviteUser, updateRole, rateUpdate, deactivateUser,
  listGroups, getGroup, createGroup, updateGroup, deleteGroup, addUser, removeUser,
];

/** Read-only startup dispatcher metadata; it grants no mutation capability. */
export const USER_GROUP_STARTUP_RECONCILIATION = Object.freeze({
  clockify_users_invite: { "invite-user": "create" },
  clockify_users_role_update: { "update-user-role": "state-command" },
  clockify_users_rate_update: { "update-user-rate": "update" },
  clockify_users_hourly_rate_update: { "update-user-hourly-rate": "update" },
  clockify_users_cost_rate_update: { "update-user-cost-rate": "update" },
  clockify_users_deactivate: { "deactivate-user": "state-command" },
  clockify_groups_create: { "create-group": "create" },
  clockify_groups_update: { "update-group": "update" },
  clockify_groups_delete: { "delete-group": "delete" },
  clockify_groups_add_user: { "add-user-to-group-*": "update" },
  clockify_groups_add_member: { "add-user-to-group": "update" },
  clockify_groups_remove_user: { "remove-user-from-group": "update" },
} as const);
