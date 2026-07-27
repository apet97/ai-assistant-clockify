import { z } from "zod";
import { zNumberLike } from "../arg-shapes.js";
import { defineRiskyAction, type ActionDefinition, type SemanticLiteralAlias } from "../action.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import {
  TIME_OFF_API_METADATA,
  commitTimeOffRequest,
  previewTimeOffRequestDays,
  previewTimeOffRequestHours,
} from "../workflows/time-off.js";

const TOA = "time_off_approvals" as const;

const timeOffSnapshotContract = (relations: ["target" | "parent", ...Array<"target" | "parent">], strategy: "create" | "update" | "delete" | "state-command") =>
  durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations }, strategies: [strategy] });

const HALF_DAY_LITERAL_ALIASES = Object.freeze([
  { path: "halfDay", value: false, authoredPhrases: Object.freeze(["full day", "full-day"]) },
  { path: "halfDay", value: true, authoredPhrases: Object.freeze(["half day", "half-day"]) },
] satisfies readonly SemanticLiteralAlias[]);

const createDays = defineRiskyAction({
  ...TIME_OFF_API_METADATA.clockify_time_off_requests_create_days,
  name: "clockify_time_off_requests_create_days",
  description:
    "Submit a DAYS time-off request with bare YYYY-MM-DD start/end dates and optional period.days or halfDay. Pass the policy id — resolved and verified server-side. External side effect — previews and requires confirmation.",
  group: TOA,
  risks: ["external_side_effect"],
  mutationWorkflow: "durable",
  mutationContract: timeOffSnapshotContract(["parent"], "create"),
  semanticLiteralAliases: HALF_DAY_LITERAL_ALIASES,
  schema: z.object({
    policyId: z.string().min(1),
    start: z.string().min(1),
    end: z.string().min(1),
    days: zNumberLike(z.number().positive()).optional(),
    halfDay: z.boolean().optional(),
    note: z.string().optional(),
  }).strict(),
  preview: (ctx, args) => previewTimeOffRequestDays(ctx, args),
  commit: commitTimeOffRequest,
});

const createHours = defineRiskyAction({
  ...TIME_OFF_API_METADATA.clockify_time_off_requests_create_hours,
  name: "clockify_time_off_requests_create_hours",
  description:
    "Submit an HOURS time-off request with full ISO datetime start/end instants (no days or half-day fields). Pass the policy id — resolved and verified server-side. External side effect — previews and requires confirmation.",
  group: TOA,
  risks: ["external_side_effect"],
  mutationWorkflow: "durable",
  mutationContract: timeOffSnapshotContract(["parent"], "create"),
  schema: z.object({
    policyId: z.string().min(1),
    start: z.string().min(1),
    end: z.string().min(1),
    note: z.string().optional(),
  }).strict(),
  preview: (ctx, args) => previewTimeOffRequestHours(ctx, args),
  commit: commitTimeOffRequest,
});

export const TIME_OFF_REQUEST_API_ACTIONS: ActionDefinition[] = [
  createDays,
  createHours,
];
