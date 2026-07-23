import { z } from "zod";
import { zNumberLike } from "../arg-shapes.js";
import {
  clarifyResult,
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionContext,
  type ActionDefinition,
  type SemanticLiteralAlias,
  type TargetSnapshot,
} from "../action.js";
import { defineDurableSafeWriteAction } from "../durable-safe-write.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { commitSingleDurableRiskyStep } from "../durable-risky-write.js";
import { listReceipt, successReceipt } from "../receipts.js";
import { captureTargetSnapshot, verifyTargetSnapshots } from "../target-snapshots.js";
import { sanitizeCompleteJson, sanitizedFingerprint } from "../safe-json.js";
import { describePatch, resolveDateRange, resolveEntityRef, resolveUserFilter, resolveUserRef } from "./resolve.js";
import { dispatchWithReconciliation, reconcileCreate } from "./structure-durable.js";
import { nowDate } from "../../durations.js";
import { DefinitiveWriteFailure } from "../../clockify/write-outcome.js";
import type { AssignmentSummary, CreateAssignmentInput } from "../../clockify/ports/scheduling.js";
import type {
  ApiAccess,
  ApiActionMetadataCarrier,
  ApiExposure,
  ApiMethod,
  AvailabilityByAuthClass,
  MaterialFieldMetadata,
} from "../api-operation.js";

/**
 * Typed scheduling workflows (goclmcp §2.10). Reads (list/get/totals) and
 * create (safe_write) execute immediately; update/delete/publish run
 * preview→commit. Risk classes: create = safe_write; update = high_risk_write;
 * delete = destructive; publish = external_side_effect (notifies assignees).
 * All gated by `scheduling`. Publish supersedes the generic clockify_manage_schedule.
 */

const SCHED = "scheduling" as const;

type SchedulingActionName =
  | "clockify_scheduling_assignments_list"
  | "clockify_scheduling_assignments_get"
  | "clockify_scheduling_assignments_create"
  | "clockify_scheduling_assignments_update"
  | "clockify_scheduling_assignments_delete"
  | "clockify_scheduling_publish"
  | "clockify_scheduling_project_totals"
  | "clockify_scheduling_project_totals_all"
  | "clockify_scheduling_project_totals_one"
  | "clockify_scheduling_user_totals";

const SCHEDULING_AVAILABILITY: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: true }),
  api_key: Object.freeze({ available: true }),
});

function schedulingEndpointKey(
  access: ApiAccess,
  method: ApiMethod,
  path: string,
  sourceModule = "scheduling.ts",
): string {
  return [access, "api", method, path, sourceModule].join("\0");
}

function schedulingMaterialField(
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

function schedulingApiMetadata(input: {
  actionName: SchedulingActionName;
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
    availabilityByAuthClass: SCHEDULING_AVAILABILITY,
    boundedArgumentDictionaries: Object.freeze([]),
    materialFields: Object.freeze([...input.materialFields]),
    presentation: Object.freeze({ presenterId: input.actionName, version: 1 }),
  });
}

function schedulingInternalMetadata(input: {
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
    availabilityByAuthClass: SCHEDULING_AVAILABILITY,
    boundedArgumentDictionaries: Object.freeze([]),
  });
}

const schedulingEndpoint = Object.freeze({
  assignmentsList: schedulingEndpointKey("read", "GET", "/workspaces/{workspaceId}/scheduling/assignments/all"),
  assignmentsCreate: schedulingEndpointKey("write", "POST", "/workspaces/{workspaceId}/scheduling/assignments/recurring"),
  assignmentsUpdate: schedulingEndpointKey("write", "PATCH", "/workspaces/{workspaceId}/scheduling/assignments/recurring/{id}"),
  assignmentsDelete: schedulingEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/scheduling/assignments/recurring/{id}"),
  assignmentsPublish: schedulingEndpointKey("write", "PUT", "/workspaces/{workspaceId}/scheduling/assignments/publish"),
  projectTotalsAll: schedulingEndpointKey("read", "POST", "/workspaces/{workspaceId}/scheduling/assignments/projects/totals"),
  projectTotalsOne: schedulingEndpointKey("read", "GET", "/workspaces/{workspaceId}/scheduling/assignments/projects/totals/{projectId}"),
  userTotals: schedulingEndpointKey("read", "GET", "/workspaces/{workspaceId}/scheduling/assignments/users/{userId}/totals"),
  usersList: schedulingEndpointKey("read", "GET", "/workspaces/{workspaceId}/users", "users.ts"),
  projectsList: schedulingEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects", "projects.ts"),
  projectsGet: schedulingEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
});

export const SCHEDULING_API_METADATA = Object.freeze({
  clockify_scheduling_assignments_list: schedulingApiMetadata({
    actionName: "clockify_scheduling_assignments_list",
    operationId: "getAllAssignments",
    method: "GET",
    path: "/workspaces/{workspaceId}/scheduling/assignments/all",
    access: "read",
    primary: schedulingEndpoint.assignmentsList,
    support: [schedulingEndpoint.usersList],
    materialFields: [],
  }),
  clockify_scheduling_assignments_get: schedulingInternalMetadata({
    exposure: "composite",
    reason: "Finds one assignment by scanning the assignment list because Clockify exposes no usable GET assignment-by-id operation; it is not a fabricated get-one operation.",
    primary: [schedulingEndpoint.assignmentsList],
    support: [],
  }),
  clockify_scheduling_assignments_create: schedulingApiMetadata({
    actionName: "clockify_scheduling_assignments_create",
    operationId: "createRecurring",
    method: "POST",
    path: "/workspaces/{workspaceId}/scheduling/assignments/recurring",
    access: "write",
    primary: schedulingEndpoint.assignmentsCreate,
    support: [
      schedulingEndpoint.usersList,
      schedulingEndpoint.projectsList,
      schedulingEndpoint.projectsGet,
      schedulingEndpoint.assignmentsList,
    ],
    materialFields: [
      schedulingMaterialField("/input/userId", "User", "entity", true),
      schedulingMaterialField("/input/projectId", "Project", "entity", true),
      schedulingMaterialField("/input/start", "Start", "text", true),
      schedulingMaterialField("/input/end", "End", "text", true),
      schedulingMaterialField("/input/hoursPerDay", "Hours per day", "number", true),
      schedulingMaterialField("/input/note", "Note", "text", false),
    ],
  }),
  clockify_scheduling_assignments_update: schedulingApiMetadata({
    actionName: "clockify_scheduling_assignments_update",
    operationId: "editRecurring",
    method: "PATCH",
    path: "/workspaces/{workspaceId}/scheduling/assignments/recurring/{id}",
    access: "write",
    primary: schedulingEndpoint.assignmentsUpdate,
    support: [schedulingEndpoint.assignmentsList],
    materialFields: [
      schedulingMaterialField("/id", "Assignment", "entity", true),
      schedulingMaterialField("/patch/hoursPerDay", "Hours per day", "number", false),
      schedulingMaterialField("/patch/note", "Note", "text", false),
      schedulingMaterialField("/patch/seriesUpdateOption", "Series update", "text", false),
    ],
  }),
  clockify_scheduling_assignments_delete: schedulingApiMetadata({
    actionName: "clockify_scheduling_assignments_delete",
    operationId: "deleteRRecurringAssignment",
    method: "DELETE",
    path: "/workspaces/{workspaceId}/scheduling/assignments/recurring/{id}",
    access: "write",
    primary: schedulingEndpoint.assignmentsDelete,
    support: [schedulingEndpoint.assignmentsList],
    materialFields: [
      schedulingMaterialField("/id", "Assignment", "entity", true),
      schedulingMaterialField("/seriesUpdateOption", "Series update", "text", false),
    ],
  }),
  clockify_scheduling_publish: schedulingApiMetadata({
    actionName: "clockify_scheduling_publish",
    operationId: "publishAssignments",
    method: "PUT",
    path: "/workspaces/{workspaceId}/scheduling/assignments/publish",
    access: "write",
    primary: schedulingEndpoint.assignmentsPublish,
    support: [schedulingEndpoint.assignmentsList, schedulingEndpoint.usersList],
    materialFields: [
      schedulingMaterialField("/start", "Start", "text", true),
      schedulingMaterialField("/end", "End", "text", true),
      schedulingMaterialField("/notifyUsers", "Notify users", "boolean", false),
      schedulingMaterialField("/userId", "User", "entity", false),
    ],
  }),
  clockify_scheduling_project_totals: schedulingInternalMetadata({
    exposure: "generic",
    reason: "Selects POST all-project totals or GET one-project totals from the optional project filter; use clockify_scheduling_project_totals_all or clockify_scheduling_project_totals_one.",
    primary: [schedulingEndpoint.projectTotalsAll, schedulingEndpoint.projectTotalsOne],
    support: [schedulingEndpoint.projectsList],
  }),
  clockify_scheduling_project_totals_all: schedulingApiMetadata({
    actionName: "clockify_scheduling_project_totals_all",
    operationId: "getFilteredProjectTotals",
    method: "POST",
    path: "/workspaces/{workspaceId}/scheduling/assignments/projects/totals",
    access: "read",
    primary: schedulingEndpoint.projectTotalsAll,
    support: [schedulingEndpoint.projectsList],
    materialFields: [],
  }),
  clockify_scheduling_project_totals_one: schedulingApiMetadata({
    actionName: "clockify_scheduling_project_totals_one",
    operationId: "getProjectTotalsForSingleProject",
    method: "GET",
    path: "/workspaces/{workspaceId}/scheduling/assignments/projects/totals/{projectId}",
    access: "read",
    primary: schedulingEndpoint.projectTotalsOne,
    support: [schedulingEndpoint.projectsList],
    materialFields: [
      schedulingMaterialField("/projectId", "Project", "entity", true),
    ],
  }),
  clockify_scheduling_user_totals: schedulingApiMetadata({
    actionName: "clockify_scheduling_user_totals",
    operationId: "getUserTotalsForSingleUser",
    method: "GET",
    path: "/workspaces/{workspaceId}/scheduling/assignments/users/{userId}/totals",
    access: "read",
    primary: schedulingEndpoint.userTotals,
    support: [schedulingEndpoint.usersList],
    materialFields: [],
  }),
} satisfies Readonly<Record<SchedulingActionName, ApiActionMetadataCarrier>>);

const seriesOption = z.enum(["ONLY_THIS", "ALL", "THIS_AND_FOLLOWING"]);

const schedulingTargetContract = (strategy: "update" | "delete" | "state-command") => durableMutationContract({
  source: "confirmed",
  targeting: { mode: "snapshots", relations: ["target"] },
  strategies: [strategy],
});

function assignmentProjection(assignment: Awaited<ReturnType<ActionContext["clockify"]["getAssignment"]>>) {
  if (!assignment) return undefined;
  return {
    id: assignment.id,
    userId: assignment.userId,
    projectId: assignment.projectId,
    start: assignment.start,
    end: assignment.end,
    hoursPerDay: assignment.hoursPerDay,
    startTime: assignment.startTime,
    note: assignment.note,
    published: assignment.published,
  };
}

function assignmentCreateProjection(input: CreateAssignmentInput) {
  return {
    userId: input.userId,
    projectId: input.projectId,
    start: input.start,
    end: input.end,
    hoursPerDay: input.hoursPerDay,
    ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
    published: false,
  };
}

function createdAssignmentProjection(assignment: AssignmentSummary) {
  return {
    userId: assignment.userId,
    projectId: assignment.projectId,
    start: assignment.start,
    end: assignment.end,
    hoursPerDay: assignment.hoursPerDay,
    ...(assignment.startTime !== undefined ? { startTime: assignment.startTime } : {}),
    ...(assignment.note !== undefined ? { note: assignment.note } : {}),
    published: assignment.published ?? false,
  };
}

/**
 * Every scheduling start/end is a `yyyy-MM-ddThh:mm:ssZ` instant on the wire
 * (OpenAPI: AssignmentCreateRequestV1 / PublishAssignmentsRequestV1 / the
 * assignments query params). The live loop sent relative words straight
 * through; resolve them server-side and STOP on anything unparseable.
 *
 * The `ok:true` bounds are INTENTIONALLY optional (string | undefined), not a
 * lying type: this helper is shared by `clockify_scheduling_assignments_list`,
 * whose `start`/`end` are legitimately optional (an unfiltered list passes
 * `args:{}` → both edges resolve to undefined → `ok:true` with no bounds, and
 * the REST list filter accepts that). So it CANNOT be narrowed to required
 * bounds — a guard that rejected undefined here would break the unfiltered
 * read. The five callers whose schemas REQUIRE both edges (`.min(1)`: create /
 * publish / project_totals / user_totals) therefore narrow locally: with a
 * non-empty raw input, resolveDateRange returns `ok:false` on an unparseable
 * date, so on the `ok:true` path both bounds are provably defined for them.
 */
export function resolveSchedulingWindow(
  ctx: ActionContext,
  args: { start?: string; end?: string },
): { ok: true; start?: string; end?: string } | { ok: false; message: string } {
  // Both edges are optional with no default (an omitted edge stays undefined);
  // the shared resolver owns the per-edge resolveInstant, the bad-date
  // collection, and the clarify copy — only the example-hint tail is ours.
  return resolveDateRange(nowDate(ctx), {
    start: { raw: args.start },
    end: { raw: args.end },
    exampleHint: "today, tomorrow, or next monday",
    timeZone: ctx.timeZone,
  });
}

const listAssignments = defineAction({
  ...SCHEDULING_API_METADATA.clockify_scheduling_assignments_list,
  name: "clockify_scheduling_assignments_list",
  description:
    "List scheduling assignments in a date range (optional user/project filter; `userId` accepts a user id, exact name, or 'me'). `start`/`end` accept YYYY-MM-DD, a full ISO instant, or a relative day (today/next monday…), resolved server-side.",
  featureGroup: SCHED,
  risks: ["read"],
  schema: z.object({ start: z.string().optional(), end: z.string().optional(), userId: z.string().optional(), projectId: z.string().optional() }),
  async handler(ctx, args) {
    const window = resolveSchedulingWindow(ctx, args);
    if (!window.ok) return { kind: "clarify", message: window.message };
    // The user filter resolves id/name/'me'; absent = all users (no default).
    const user = await resolveUserFilter(args.userId, {
      verb: "list assignments for",
      adminUserId: ctx.adminUserId,
      listUsers: () => ctx.clockify.listUsers(),
    });
    if (!user.ok) return clarifyResult(user.clarify);
    const { rows, truncated } = await ctx.clockify.listAssignments({ ...args, userId: user.userId, start: window.start, end: window.end });
    return {
      kind: "receipt",
      receipt: listReceipt({ action: "clockify_scheduling_assignments_list", entity: "assignment", ids: { workspaceId: ctx.workspaceId }, rows, truncated }),
    };
  },
});

const getAssignment = defineReadAction({
  ...SCHEDULING_API_METADATA.clockify_scheduling_assignments_get,
  name: "clockify_scheduling_assignments_get",
  description: "Fetch a single scheduling assignment by id.",
  group: SCHED,
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getAssignment(args.id);
    return successReceipt({ action: "clockify_scheduling_assignments_get", entity: "assignment", ids: { workspaceId: ctx.workspaceId }, data: { entity } });
  },
});

const createAssignment = defineDurableSafeWriteAction({
  ...SCHEDULING_API_METADATA.clockify_scheduling_assignments_create,
  name: "clockify_scheduling_assignments_create",
  description:
    "Create a scheduling assignment (draft) for ONE user (Clockify scheduling is per-user — there is no group assignment). Pass `userId` and `projectId` as ids or exact names (or 'me' for the user) — resolved server-side, clarifies on an unknown one. `start`/`end` accept YYYY-MM-DD or a relative day (today/next monday…). Safe write — executes immediately when policy allows.",
  group: SCHED,
  stepName: "Create scheduling assignment",
  mutationContract: durableMutationContract({
    source: "safe",
    targeting: { mode: "snapshots", relations: ["parent", "parent"] },
    strategies: ["create"],
  }),
  schema: z.object({
    userId: z.string().min(1),
    projectId: z.string().min(1),
    start: z.string().min(1),
    end: z.string().min(1),
    hoursPerDay: zNumberLike(z.number().min(0.5).max(24)),
    note: z.string().optional(),
  }),
  async prepare(ctx, args) {
    const window = resolveSchedulingWindow(ctx, args);
    if (!window.ok) return { kind: "clarify" as const, clarify: window.message };
    const user = await resolveUserRef({ id: args.userId }, { verb: "schedule", adminUserId: ctx.adminUserId, listUsers: () => ctx.clockify.listUsers() });
    if (!user.ok) {
      return {
        kind: "clarify" as const,
        clarify: user.clarify.clarify,
        ...(user.clarify.options ? { options: user.clarify.options } : {}),
      };
    }
    const project = await resolveEntityRef(
      { id: args.projectId },
      { noun: "project", verb: "schedule on", list: (f) => ctx.clockify.listProjects(f), verifyId: true },
    );
    if (!project.ok) {
      return {
        kind: "clarify" as const,
        clarify: project.clarify.clarify,
        ...(project.clarify.options ? { options: project.clarify.options } : {}),
      };
    }

    const users = await ctx.clockify.listUsers();
    if (users.truncated) {
      return { kind: "clarify" as const, clarify: "Clockify returned an incomplete user list. Retry after the assignment's user can be verified completely." };
    }
    const userRow = users.rows.find((candidate) => candidate.id === user.userId);
    if (!userRow) {
      return { kind: "clarify" as const, clarify: `I couldn't verify workspace user ${user.userId}. Give me a current user id or exact name.` };
    }
    const projectRow = await ctx.clockify.getProject(project.id);
    if (!projectRow) {
      return { kind: "clarify" as const, clarify: `I couldn't verify project ${project.id}. Give me a current project id or exact name.` };
    }

    const input: CreateAssignmentInput = {
      ...args,
      userId: user.userId,
      projectId: project.id,
      start: window.start as string,
      end: window.end as string,
    };
    const filter = {
      userId: input.userId,
      projectId: input.projectId,
      start: input.start,
      end: input.end,
    };
    const baseline = await ctx.clockify.listAssignments(filter);
    if (baseline.truncated) {
      return { kind: "clarify" as const, clarify: "Clockify returned an incomplete scheduling baseline. Retry after the assignment range can be read completely." };
    }
    const baselineIds = baseline.rows.map((row) => row.id).sort();
    const targetSnapshots = [
      captureTargetSnapshot("parent", { type: "user", id: userRow.id, name: userRow.name }, userRow),
      captureTargetSnapshot("parent", { type: "project", id: projectRow.id, name: projectRow.name }, projectRow),
    ];
    const finalFingerprint = sanitizedFingerprint(assignmentCreateProjection(input));
    return {
      operation: {
        input,
        filter,
        baselineIds,
        baselineFingerprint: sanitizedFingerprint(baselineIds),
        finalFingerprint,
        targetSnapshots,
      },
      mutationPlan: {
        mode: "single" as const,
        steps: [{
          id: "create-assignment",
          kind: "primary" as const,
          targetFingerprint: sanitizedFingerprint({ parents: targetSnapshots.map((snapshot) => snapshot.fingerprint), finalFingerprint }),
          reconciliationStrategy: "create" as const,
        }],
      },
    };
  },
  async dispatch(ctx, operation) {
    const prepared = operation as {
      input: CreateAssignmentInput;
      filter: { userId: string; projectId: string; start: string; end: string };
      baselineIds: string[];
      baselineFingerprint: string;
      finalFingerprint: string;
      targetSnapshots: TargetSnapshot[];
    };
    const verified = await verifyTargetSnapshots(prepared.targetSnapshots, async (snapshot) => {
      if (snapshot.ref.type === "user") {
        const users = await ctx.clockify.listUsers();
        const row = users.rows.find((candidate) => candidate.id === snapshot.ref.id);
        return row
          ? { ref: { type: "user", id: row.id, name: row.name }, projection: row, truncated: users.truncated }
          : undefined;
      }
      if (snapshot.ref.type === "project") {
        const row = await ctx.clockify.getProject(snapshot.ref.id);
        return row
          ? { ref: { type: "project", id: row.id, name: row.name }, projection: row, truncated: false }
          : undefined;
      }
      return undefined;
    });
    if (!verified.ok) {
      throw new DefinitiveWriteFailure("VERIFY", verified.code, verified.message);
    }

    const currentBaseline = await ctx.clockify.listAssignments(prepared.filter);
    const currentIds = currentBaseline.rows.map((row) => row.id).sort();
    if (currentBaseline.truncated || sanitizedFingerprint(currentIds) !== prepared.baselineFingerprint) {
      throw new DefinitiveWriteFailure(
        "VERIFY",
        "stale_parent",
        "The scheduling range changed after preparation. Create a fresh request before adding the assignment.",
      );
    }

    const dispatch = await dispatchWithReconciliation({
      dispatch: () => ctx.clockify.createAssignmentAtomic(prepared.input),
      reconcile: async () => {
        const row = await reconcileCreate({
          beforeIds: prepared.baselineIds,
          list: () => ctx.clockify.listAssignments(prepared.filter),
          matches: (candidate) => sanitizedFingerprint(createdAssignmentProjection(candidate)) === prepared.finalFingerprint,
        });
        return row ? { id: row.id, name: row.id } : undefined;
      },
    });
    const assignment = dispatch.value;
    const created = { type: "assignment", id: assignment.id };
    return {
      result: successReceipt({
        action: "clockify_scheduling_assignments_create",
        entity: "assignment",
        ids: { workspaceId: ctx.workspaceId },
        changed: { created: [created] },
      }),
      externalId: assignment.id,
      effect: { created },
      detail: { reconciled: dispatch.reconciled },
    };
  },
});

const updateAssignment = defineRiskyAction({
  ...SCHEDULING_API_METADATA.clockify_scheduling_assignments_update,
  name: "clockify_scheduling_assignments_update",
  description: "Update a scheduling assignment. Elevated write — previews and requires confirmation.",
  group: SCHED,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: schedulingTargetContract("update"),
  schema: z
    .object({ id: z.string().min(1), hoursPerDay: zNumberLike(z.number().min(0.5).max(24)).optional(), note: z.string().optional(), seriesUpdateOption: seriesOption.optional() })
    .refine((v) => v.hoursPerDay !== undefined || v.note !== undefined, { message: "Provide hoursPerDay or note to change." }),
  async preview(ctx, args) {
    const current = await ctx.clockify.getAssignment(args.id);
    if (!current) return { clarify: `I couldn't verify scheduling assignment ${args.id}. Give me a current assignment id.` };
    const projection = assignmentProjection(current)!;
    const targetSnapshot = captureTargetSnapshot("target", { type: "assignment", id: current.id }, projection);
    let body: Awaited<ReturnType<typeof ctx.clockify.prepareAssignmentUpdate>>;
    try {
      body = await ctx.clockify.prepareAssignmentUpdate(current.id, args);
    } catch {
      return { clarify: `I couldn't prepare a complete replacement for assignment ${args.id}. Refresh it and try again.` };
    }
    const patch = {
      ...(args.hoursPerDay !== undefined ? { hoursPerDay: args.hoursPerDay } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
      ...(args.seriesUpdateOption !== undefined ? { seriesUpdateOption: args.seriesUpdateOption } : {}),
    };
    return {
      actionLabel: "Update scheduling assignment",
      targets: [{ type: "assignment", id: args.id }],
      expectedChanges: describePatch(patch),
      reversibility: "You can update the assignment again.",
      warnings: ["This changes a user's scheduled work."],
      payload: {
        id: current.id,
        patch,
        body,
        expectedProjection: sanitizeCompleteJson({
          id: current.id,
          userId: body.userId,
          projectId: body.projectId,
          start: body.start,
          end: body.end,
          hoursPerDay: body.hoursPerDay,
          startTime: body.startTime,
          note: body.note,
          published: current.published,
        }),
      },
      targetSnapshots: [targetSnapshot],
      mutationPlan: { mode: "single", steps: [{ id: "update-assignment", kind: "primary", targetFingerprint: targetSnapshot.fingerprint, reconciliationStrategy: "update" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { id, body, expectedProjection } = payload as {
      id: string;
      body: Parameters<typeof ctx.clockify.updateAssignmentAtomic>[1];
      expectedProjection: unknown;
    };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "update-assignment", name: "Update scheduling assignment",
      verification: {
        snapshots: operation.targetSnapshots ?? [],
        async fetchSnapshot() {
          const current = await ctx.clockify.getAssignment(id);
          return current ? { ref: { type: "assignment", id }, projection: assignmentProjection(current) } : undefined;
        },
      },
      async dispatch() {
        const dispatched = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.updateAssignmentAtomic(id, body),
          reconcile: async () => {
            const current = await ctx.clockify.getAssignment(id);
            return current && sanitizedFingerprint(assignmentProjection(current)) === sanitizedFingerprint(expectedProjection)
              ? { id: current.id, name: current.id }
              : undefined;
          },
        });
        const updated = dispatched.value;
        return { externalId: updated.id, effect: { updated: { type: "assignment", id: updated.id } }, detail: { reconciled: dispatched.reconciled } };
      },
      success: (step) => successReceipt({ action: "clockify_scheduling_assignments_update", entity: "assignment", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "assignment", id: step.externalId ?? id }] } }),
    });
  },
});

const deleteAssignment = defineRiskyAction({
  ...SCHEDULING_API_METADATA.clockify_scheduling_assignments_delete,
  name: "clockify_scheduling_assignments_delete",
  description: "Delete a scheduling assignment. Destructive — previews and requires confirmation.",
  group: SCHED,
  risks: ["destructive"],
  mutationWorkflow: "durable",
  mutationContract: schedulingTargetContract("delete"),
  schema: z.object({ id: z.string().min(1), seriesUpdateOption: seriesOption.optional() }),
  async preview(ctx, args) {
    const current = await ctx.clockify.getAssignment(args.id);
    if (!current) return { clarify: `I couldn't verify scheduling assignment ${args.id}. Give me a current assignment id.` };
    const targetSnapshot = captureTargetSnapshot("target", { type: "assignment", id: current.id }, assignmentProjection(current));
    return {
      actionLabel: "Delete scheduling assignment",
      targets: [{ type: "assignment", id: args.id }],
      expectedChanges: [`Delete scheduling assignment ${args.id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting an assignment removes scheduled work."],
      payload: { id: current.id, ...(args.seriesUpdateOption !== undefined ? { seriesUpdateOption: args.seriesUpdateOption } : {}) },
      targetSnapshots: [targetSnapshot],
      mutationPlan: { mode: "single", steps: [{ id: "delete-assignment", kind: "primary", targetFingerprint: targetSnapshot.fingerprint, reconciliationStrategy: "delete" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { id, seriesUpdateOption } = payload as { id: string; seriesUpdateOption?: string };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "delete-assignment", name: "Delete scheduling assignment",
      verification: {
        snapshots: operation.targetSnapshots ?? [],
        async fetchSnapshot() {
          const current = await ctx.clockify.getAssignment(id);
          return current ? { ref: { type: "assignment", id }, projection: assignmentProjection(current) } : undefined;
        },
      },
      async dispatch() {
        const dispatched = await dispatchWithReconciliation({
          dispatch: async () => { await ctx.clockify.deleteAssignmentAtomic(id, seriesUpdateOption); return true; },
          reconcile: async () => {
            const current = await ctx.clockify.listAssignments();
            return !current.truncated && !current.rows.some((row) => row.id === id) ? true : undefined;
          },
        });
        return { externalId: id, effect: { deleted: { type: "assignment", id } }, detail: { reconciled: dispatched.reconciled } };
      },
      success: () => successReceipt({ action: "clockify_scheduling_assignments_delete", entity: "assignment", ids: { workspaceId: ctx.workspaceId }, changed: { deleted: [{ type: "assignment", id }] } }),
    });
  },
});

const publish = defineRiskyAction({
  ...SCHEDULING_API_METADATA.clockify_scheduling_publish,
  name: "clockify_scheduling_publish",
  description:
    "Publish draft scheduling assignments in a date range. Publishes ALL drafts overlapping the range unless you pass `userId` (or a user's exact name / 'me') to scope it to one person. External side effect (notifies assignees) — previews and requires confirmation.",
  group: SCHED,
  risks: ["external_side_effect"],
  mutationWorkflow: "durable",
  mutationContract: schedulingTargetContract("state-command"),
  semanticLiteralAliases: Object.freeze([
    { path: "notifyUsers", value: false, authoredPhrases: Object.freeze(["do not notify users", "don't notify users", "without notifications"]) },
    { path: "notifyUsers", value: true, authoredPhrases: Object.freeze(["notify users", "send notifications"]) },
  ] satisfies readonly SemanticLiteralAlias[]),
  schema: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
    notifyUsers: z.boolean().optional(),
    /** Optional: narrow the publish to ONE user (id, exact name, or 'me'). */
    userId: z.string().min(1).optional(),
  }),
  async preview(ctx, args) {
    const window = resolveSchedulingWindow(ctx, args);
    if (!window.ok) return { clarify: window.message };
    const { start, end } = window as { start: string; end: string };
    // Optional user scoping narrows the blast radius from the whole range to one
    // person (userFilter). A bogus name clarifies, never a doomed publish.
    let scopedId: string | undefined;
    let scopedLabel: string | undefined;
    if (args.userId !== undefined) {
      const user = await resolveUserRef(
        { id: args.userId },
        { verb: "publish the schedule for", adminUserId: ctx.adminUserId, listUsers: () => ctx.clockify.listUsers() },
      );
      if (!user.ok) return user.clarify;
      scopedId = user.userId;
      scopedLabel = user.label;
    }
    const notify = args.notifyUsers ? " (notify users)" : "";
    const rangeEvidence = await ctx.clockify.listAssignments({ start, end, ...(scopedId ? { userId: scopedId } : {}) });
    if (rangeEvidence.truncated) return { clarify: "Clockify returned an incomplete schedule range. Narrow the range before publishing." };
    const rangeProjection = {
      start, end, notifyUsers: args.notifyUsers ?? false, userId: scopedId,
      assignments: [...rangeEvidence.rows].sort((a, b) => a.id.localeCompare(b.id)).map(assignmentProjection),
    };
    const rangeId = sanitizedFingerprint({ start, end, userId: scopedId });
    const targetSnapshot = captureTargetSnapshot("target", { type: "schedule-range", id: rangeId }, rangeProjection);
    const expectedProjection = sanitizeCompleteJson({
      ...rangeProjection,
      assignments: rangeProjection.assignments.map((assignment) => ({ ...assignment, published: true })),
    });
    return {
      actionLabel: "Publish schedule",
      targets: [],
      expectedChanges: [
        scopedId
          ? `Publish draft scheduling assignments for ${scopedLabel} overlapping ${start} → ${end}${notify}`
          : `Publish ALL draft scheduling assignments overlapping ${start} → ${end}${notify}`,
      ],
      reversibility: "Publishing notifies assignees and is hard to reverse.",
      warnings: [
        scopedId
          ? `This publishes every draft assignment for ${scopedLabel} overlapping the range and may email them.`
          : "This publishes EVERY draft assignment overlapping the range — not just recently-created ones — and may email affected users.",
      ],
      payload: { start, end, expectedProjection, ...(args.notifyUsers !== undefined ? { notifyUsers: args.notifyUsers } : {}), ...(scopedId ? { userId: scopedId } : {}) },
      targetSnapshots: [targetSnapshot],
      mutationPlan: { mode: "single", steps: [{ id: "publish-schedule", kind: "primary", targetFingerprint: targetSnapshot.fingerprint, reconciliationStrategy: "state-command" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { start, end, notifyUsers, userId, expectedProjection } = payload as { start: string; end: string; notifyUsers?: boolean; userId?: string; expectedProjection: unknown };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "publish-schedule", name: "Publish schedule",
      verification: {
        snapshots: operation.targetSnapshots ?? [],
        async fetchSnapshot(snapshot: TargetSnapshot) {
          const evidence = await ctx.clockify.listAssignments({ start, end, ...(userId ? { userId } : {}) });
          return {
            ref: snapshot.ref,
            truncated: evidence.truncated,
            projection: {
              start, end, notifyUsers: notifyUsers ?? false, userId,
              assignments: [...evidence.rows].sort((a, b) => a.id.localeCompare(b.id)).map(assignmentProjection),
            },
          };
        },
      },
      async dispatch() {
        const dispatched = await dispatchWithReconciliation({
          dispatch: async () => { await ctx.clockify.publishScheduleAtomic({ start, end, notifyUsers, userId }); return true; },
          reconcile: async () => {
            const evidence = await ctx.clockify.listAssignments({ start, end, ...(userId ? { userId } : {}) });
            if (evidence.truncated) return undefined;
            const projection = {
              start, end, notifyUsers: notifyUsers ?? false, userId,
              assignments: [...evidence.rows].sort((a, b) => a.id.localeCompare(b.id)).map(assignmentProjection),
            };
            return sanitizedFingerprint(projection) === sanitizedFingerprint(expectedProjection) ? true : undefined;
          },
        });
        return { effect: { published: true, start, end, userId }, detail: { reconciled: dispatched.reconciled } };
      },
      success: () => successReceipt({ action: "clockify_scheduling_publish", entity: "schedule", ids: { workspaceId: ctx.workspaceId }, data: { published: true, start, end, ...(userId ? { userId } : {}) } }),
    });
  },
});

const projectTotals = defineAction({
  ...SCHEDULING_API_METADATA.clockify_scheduling_project_totals,
  name: "clockify_scheduling_project_totals",
  description:
    "Get scheduled-hours totals per project in a date range (`start`/`end` accept relative days, resolved server-side). Filter to one project by `projectId` or its exact `projectName` (resolved server-side).",
  featureGroup: SCHED,
  risks: ["read"],
  schema: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
    projectId: z.string().optional(),
    projectName: z.string().optional(),
  }),
  async handler(ctx, args) {
    const window = resolveSchedulingWindow(ctx, args);
    if (!window.ok) return { kind: "clarify", message: window.message };
    // A name in either filter slot resolves to a verified id; unknown clarifies.
    let projectId: string | undefined;
    if (args.projectId?.trim() || args.projectName?.trim()) {
      const project = await resolveEntityRef(
        { id: args.projectId, name: args.projectName },
        { noun: "project", verb: "total", list: (f) => ctx.clockify.listProjects(f) },
      );
      if (!project.ok) {
        return clarifyResult(project.clarify);
      }
      projectId = project.id;
    }
    const { rows, truncated } = await ctx.clockify.getProjectScheduleTotals({
      projectId,
      start: window.start as string,
      end: window.end as string,
    });
    return {
      kind: "receipt",
      receipt: listReceipt({ action: "clockify_scheduling_project_totals", entity: "schedule", ids: { workspaceId: ctx.workspaceId }, rows, truncated }),
    };
  },
});

const userTotals = defineAction({
  ...SCHEDULING_API_METADATA.clockify_scheduling_user_totals,
  name: "clockify_scheduling_user_totals",
  description:
    "Get a user's scheduled-hours totals in a date range (defaults to you; `userId` accepts a user id, exact name, or 'me'; `start`/`end` accept relative days, resolved server-side).",
  featureGroup: SCHED,
  risks: ["read"],
  schema: z.object({ userId: z.string().optional(), start: z.string().min(1), end: z.string().min(1) }),
  async handler(ctx, args) {
    const window = resolveSchedulingWindow(ctx, args);
    if (!window.ok) return { kind: "clarify", message: window.message };
    const user = await resolveUserFilter(args.userId, {
      verb: "total scheduled hours for",
      adminUserId: ctx.adminUserId,
      listUsers: () => ctx.clockify.listUsers(),
      defaultTo: ctx.adminUserId,
    });
    if (!user.ok) return clarifyResult(user.clarify);
    const data = await ctx.clockify.getUserScheduleTotals(user.userId, {
      start: window.start as string,
      end: window.end as string,
    });
    return {
      kind: "receipt",
      receipt: successReceipt({ action: "clockify_scheduling_user_totals", entity: "schedule", ids: { workspaceId: ctx.workspaceId }, data: { totals: data } }),
    };
  },
});

export const SCHEDULING_ACTIONS: ActionDefinition[] = [
  listAssignments,
  getAssignment,
  createAssignment,
  updateAssignment,
  deleteAssignment,
  publish,
  projectTotals,
  userTotals,
];

/** Read-only startup dispatcher metadata; it grants no mutation capability. */
export const SCHEDULING_STARTUP_RECONCILIATION = Object.freeze({
  clockify_scheduling_assignments_create: { "create-assignment": "create" },
  clockify_scheduling_assignments_update: { "update-assignment": "update" },
  clockify_scheduling_assignments_delete: { "delete-assignment": "delete" },
  clockify_scheduling_publish: { "publish-schedule": "state-command" },
} as const);
