import { z } from "zod";
import { clarifyResult, defineAction, type ActionDefinition } from "../action.js";
import { listReceipt } from "../receipts.js";
import { resolveEntityRef } from "../workflows/resolve.js";
import { SCHEDULING_API_METADATA, resolveSchedulingWindow } from "../workflows/scheduling.js";

const SCHED = "scheduling" as const;

const projectTotalsAll = defineAction({
  ...SCHEDULING_API_METADATA.clockify_scheduling_project_totals_all,
  name: "clockify_scheduling_project_totals_all",
  description:
    "Get scheduled-hours totals for all projects in a date range (`start`/`end` accept relative days, resolved server-side) via the POST all-projects search.",
  featureGroup: SCHED,
  risks: ["read"],
  schema: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
  }),
  async handler(ctx, args) {
    const window = resolveSchedulingWindow(ctx, args);
    if (!window.ok) return { kind: "clarify", message: window.message };
    const { rows, truncated } = await ctx.clockify.getAllProjectScheduleTotals({
      start: window.start as string,
      end: window.end as string,
    });
    return {
      kind: "receipt",
      receipt: listReceipt({
        action: "clockify_scheduling_project_totals_all",
        entity: "schedule",
        ids: { workspaceId: ctx.workspaceId },
        rows,
        truncated,
      }),
    };
  },
});

const projectTotalsOne = defineAction({
  ...SCHEDULING_API_METADATA.clockify_scheduling_project_totals_one,
  name: "clockify_scheduling_project_totals_one",
  description:
    "Get scheduled-hours totals for one project in a date range (`start`/`end` accept relative days; pass `projectId` or exact `projectName`, resolved server-side). Uses GET …/totals/{projectId}.",
  featureGroup: SCHED,
  risks: ["read"],
  schema: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
    projectId: z.string().optional(),
    projectName: z.string().optional(),
  }).refine((value) => value.projectId !== undefined || value.projectName !== undefined, {
    message: "Provide the project id or its exact name.",
  }),
  async handler(ctx, args) {
    const window = resolveSchedulingWindow(ctx, args);
    if (!window.ok) return { kind: "clarify", message: window.message };
    const project = await resolveEntityRef(
      { id: args.projectId, name: args.projectName },
      { noun: "project", verb: "total", list: (filter) => ctx.clockify.listProjects(filter) },
    );
    if (!project.ok) return clarifyResult(project.clarify, "projectId");
    const { rows, truncated } = await ctx.clockify.getOneProjectScheduleTotals({
      projectId: project.id,
      start: window.start as string,
      end: window.end as string,
    });
    return {
      kind: "receipt",
      receipt: listReceipt({
        action: "clockify_scheduling_project_totals_one",
        entity: "schedule",
        ids: { workspaceId: ctx.workspaceId },
        rows,
        truncated,
      }),
    };
  },
});

export const SCHEDULING_TOTALS_API_ACTIONS: ActionDefinition[] = [
  projectTotalsAll,
  projectTotalsOne,
];
