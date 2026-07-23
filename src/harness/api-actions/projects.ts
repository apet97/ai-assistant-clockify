import { z } from "zod";
import {
  commitDeleteArchivedProject,
  commitProjectMemberRateStep,
  commitProjectMembershipReplace,
  previewDeleteArchivedProject,
  previewProjectMemberRate,
  previewProjectMembershipReplace,
  projectMemberRateSchema,
  projectMembershipReplaceSchema,
} from "../workflows/project-action-shared.js";
import {
  defineRiskyAction,
  type ActionDefinition,
  type SemanticLiteralAlias,
} from "../action.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { STRUCTURE_API_METADATA } from "../workflows/structure-api-metadata.js";

const PROJECT_GROUP = "work_structure" as const;
const MEMBER_RATE_LITERAL_ALIASES = Object.freeze([
  { path: "userId", value: "me", authoredPhrases: Object.freeze(["my", "myself"]) },
] satisfies readonly SemanticLiteralAlias[]);

const deleteArchived = defineRiskyAction({
  name: "clockify_projects_delete_archived",
  ...STRUCTURE_API_METADATA.clockify_projects_delete_archived,
  description:
    "Delete an already-archived project with a single DELETE (Clockify rejects deleting an active project). Pass the project id or its exact name. Previews and requires confirmation.",
  group: PROJECT_GROUP,
  risks: ["destructive"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["target"] }, strategies: ["delete"] }),
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the project id or its exact name.",
    }),
  preview: (ctx, args) => previewDeleteArchivedProject(ctx, args),
  commit: (ctx, payload, operation) => commitDeleteArchivedProject(ctx, payload, operation, "clockify_projects_delete_archived"),
});

const memberHourlyRateUpdate = defineRiskyAction({
  name: "clockify_projects_member_hourly_rate_update",
  ...STRUCTURE_API_METADATA.clockify_projects_member_hourly_rate_update,
  description:
    'Set a project member\'s billable hourly rate. Pass the project by `projectId` or exact `projectName`, the member by `userId`/`userName` (use "me" for the requesting admin). The member must already be on the project. Billing action — previews and requires confirmation.',
  group: "invoices",
  risks: ["billing"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["target"] }, strategies: ["update"] }),
  semanticLiteralAliases: MEMBER_RATE_LITERAL_ALIASES,
  schema: projectMemberRateSchema,
  preview: (ctx, args) => previewProjectMemberRate(ctx, args, {
    rateKind: "HOURLY",
    planStepId: "update-project-member-hourly-rate",
  }),
  commit: (ctx, payload, operation) => commitProjectMemberRateStep(
    ctx,
    operation,
    payload as { projectId: string; userId: string; amountMinor: number; since?: string },
    {
      planStepId: "update-project-member-hourly-rate",
      stepName: "Update project member hourly rate",
      actionName: "clockify_projects_member_hourly_rate_update",
      dispatch: (input) => ctx.clockify.updateProjectMemberHourlyRateAtomic(input),
      reconcileRateKey: "hourlyRate",
    },
  ),
});

const memberCostRateUpdate = defineRiskyAction({
  name: "clockify_projects_member_cost_rate_update",
  ...STRUCTURE_API_METADATA.clockify_projects_member_cost_rate_update,
  description:
    'Set a project member\'s cost rate. Pass the project by `projectId` or exact `projectName`, the member by `userId`/`userName` (use "me" for the requesting admin). The member must already be on the project. Billing action — previews and requires confirmation.',
  group: "invoices",
  risks: ["billing"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["target"] }, strategies: ["update"] }),
  semanticLiteralAliases: MEMBER_RATE_LITERAL_ALIASES,
  schema: projectMemberRateSchema,
  preview: (ctx, args) => previewProjectMemberRate(ctx, args, {
    rateKind: "COST",
    planStepId: "update-project-member-cost-rate",
  }),
  commit: (ctx, payload, operation) => commitProjectMemberRateStep(
    ctx,
    operation,
    payload as { projectId: string; userId: string; amountMinor: number; since?: string },
    {
      planStepId: "update-project-member-cost-rate",
      stepName: "Update project member cost rate",
      actionName: "clockify_projects_member_cost_rate_update",
      dispatch: (input) => ctx.clockify.updateProjectMemberCostRateAtomic(input),
      reconcileRateKey: "costRate",
    },
  ),
});

const membershipsReplace = defineRiskyAction({
  name: "clockify_projects_memberships_replace",
  ...STRUCTURE_API_METADATA.clockify_projects_memberships_replace,
  description:
    "Replace who can access/track a project by passing the full membership set. Pass the project `id` or its exact `name`. Elevated write — previews and requires confirmation.",
  group: "users_groups",
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["target"] }, strategies: ["update"] }),
  schema: projectMembershipReplaceSchema,
  preview: (ctx, args) => previewProjectMembershipReplace(ctx, args),
  commit: (ctx, payload, operation) => commitProjectMembershipReplace(ctx, payload, operation, "clockify_projects_memberships_replace"),
});

export const PROJECT_API_ACTIONS: ActionDefinition[] = [
  deleteArchived,
  memberHourlyRateUpdate,
  memberCostRateUpdate,
  membershipsReplace,
];
