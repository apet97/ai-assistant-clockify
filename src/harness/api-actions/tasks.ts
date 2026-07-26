import {
  commitDeleteCompletedTask,
  commitTaskAssigneesReplace,
  commitTaskRateStep,
  commitTaskStatusUpdate,
  previewDeleteCompletedTask,
  previewTaskAssigneesReplace,
  previewTaskRate,
  previewTaskStatusUpdate,
  taskAssigneesReplaceSchema,
  taskRateSchema,
  taskStatusUpdateSchema,
  taskTargetRefSchema,
} from "../workflows/task-action-shared.js";
import { defineRiskyAction, type ActionDefinition } from "../action.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { STRUCTURE_API_METADATA } from "../workflows/structure-api-metadata.js";

const WORK = "work_structure" as const;

const deleteCompleted = defineRiskyAction({
  name: "clockify_tasks_delete_completed",
  ...STRUCTURE_API_METADATA.clockify_tasks_delete_completed,
  description:
    "Delete a task that is already DONE with a single DELETE (Clockify rejects deleting a non-DONE task). Pass the project and task by id or exact name. Previews and requires confirmation.",
  group: WORK,
  risks: ["destructive"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["parent", "target"] }, strategies: ["delete"] }),
  schema: taskTargetRefSchema,
  referenceSelector: {
    entityType: "task",
    bindings: [
      { referenceField: "externalId", argumentPath: "/id" },
      { referenceField: "scope.projectId", argumentPath: "/projectId" },
    ],
  },
  preview: (ctx, args) => previewDeleteCompletedTask(ctx, args),
  commit: (ctx, payload, operation) => commitDeleteCompletedTask(ctx, payload, operation, "clockify_tasks_delete_completed"),
});

const statusUpdate = defineRiskyAction({
  name: "clockify_tasks_status_update",
  ...STRUCTURE_API_METADATA.clockify_tasks_status_update,
  description:
    "Update a task's status (ACTIVE or DONE). Pass the project and task by id or exact name — the harness resolves names server-side. Elevated write — previews and requires confirmation.",
  group: WORK,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["parent", "target"] }, strategies: ["update"] }),
  schema: taskStatusUpdateSchema,
  preview: (ctx, args) => previewTaskStatusUpdate(ctx, args),
  commit: (ctx, payload, operation) => commitTaskStatusUpdate(ctx, payload, operation, "clockify_tasks_status_update"),
});

const assigneesReplace = defineRiskyAction({
  name: "clockify_tasks_assignees_replace",
  ...STRUCTURE_API_METADATA.clockify_tasks_assignees_replace,
  description:
    "Replace who is assigned to a task by passing the full assignee set. Each entry is a user id, an exact name, or 'me' (resolved server-side). Elevated write — previews and requires confirmation.",
  group: "users_groups",
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["parent", "target"] }, strategies: ["update"] }),
  schema: taskAssigneesReplaceSchema,
  preview: (ctx, args) => previewTaskAssigneesReplace(ctx, args),
  commit: (ctx, payload, operation) => commitTaskAssigneesReplace(ctx, payload, operation, "clockify_tasks_assignees_replace"),
});

const hourlyRateUpdate = defineRiskyAction({
  name: "clockify_tasks_hourly_rate_update",
  ...STRUCTURE_API_METADATA.clockify_tasks_hourly_rate_update,
  description:
    "Set a task's billable hourly rate. Pass the project and task by id or exact name — the harness resolves and verifies the task server-side. Billing action — previews and requires confirmation.",
  group: "invoices",
  risks: ["billing"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["parent", "target"] }, strategies: ["update"] }),
  schema: taskRateSchema,
  preview: (ctx, args) => previewTaskRate(ctx, args, { rateKind: "HOURLY", planStepId: "update-task-hourly-rate" }),
  commit: (ctx, payload, operation) => commitTaskRateStep(
    ctx,
    operation,
    payload as { projectId: string; taskId: string; amountMinor: number; since?: string },
    {
      planStepId: "update-task-hourly-rate",
      stepName: "Update task hourly rate",
      actionName: "clockify_tasks_hourly_rate_update",
      dispatch: (input) => ctx.clockify.updateTaskHourlyRateAtomic(input),
      reconcileRateKey: "hourlyRate",
    },
  ),
});

const costRateUpdate = defineRiskyAction({
  name: "clockify_tasks_cost_rate_update",
  ...STRUCTURE_API_METADATA.clockify_tasks_cost_rate_update,
  description:
    "Set a task's cost rate. Pass the project and task by id or exact name — the harness resolves and verifies the task server-side. Billing action — previews and requires confirmation.",
  group: "invoices",
  risks: ["billing"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["parent", "target"] }, strategies: ["update"] }),
  schema: taskRateSchema,
  preview: (ctx, args) => previewTaskRate(ctx, args, { rateKind: "COST", planStepId: "update-task-cost-rate" }),
  commit: (ctx, payload, operation) => commitTaskRateStep(
    ctx,
    operation,
    payload as { projectId: string; taskId: string; amountMinor: number; since?: string },
    {
      planStepId: "update-task-cost-rate",
      stepName: "Update task cost rate",
      actionName: "clockify_tasks_cost_rate_update",
      dispatch: (input) => ctx.clockify.updateTaskCostRateAtomic(input),
      reconcileRateKey: "costRate",
    },
  ),
});

export const TASK_API_ACTIONS: ActionDefinition[] = [
  deleteCompleted,
  statusUpdate,
  assigneesReplace,
  hourlyRateUpdate,
  costRateUpdate,
];
