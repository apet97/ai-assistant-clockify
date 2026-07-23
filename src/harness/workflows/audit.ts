import { z } from "zod";
import { defineAction, defineReadAction, type ActionContext, type ActionDefinition } from "../action.js";
import { listReceipt } from "../receipts.js";
import { SEVEN_DAYS_MS } from "../../durations.js";
import type {
  ApiActionMetadataCarrier,
  AvailabilityByAuthClass,
} from "../api-operation.js";

/**
 * Typed audit workflows (goclmcp §2.15). Both reads. The audit-log search runs on
 * the AUDIT host; the entity-changes feed on the primary host. Results are
 * byte-capped (no silent truncation). Gated by `audit_log`. NOTE: the production
 * add-on-token clearance for the audit host is unverified (no LIVE_ADDON_TOKEN);
 * the API-key dev path is spike-confirmed.
 */

const AUD = "audit_log" as const;
const AUDIT_MAX_BYTES = 200_000;

type AuditActionName =
  | "clockify_audit_logs_search"
  | "clockify_entity_changes_created"
  | "clockify_entity_changes_updated"
  | "clockify_entity_changes_deleted"
  | "clockify_entity_changes_list";

const AUDIT_AVAILABLE_TO_BOTH: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: true }),
  api_key: Object.freeze({ available: true }),
});

const AUDIT_OPERATION_ID_MISSING: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: false, reason: "official_operation_id_missing" }),
  api_key: Object.freeze({ available: false, reason: "official_operation_id_missing" }),
});

function auditEndpointKey(
  host: "api" | "audit",
  method: "GET" | "POST",
  path: string,
): string {
  return ["read", host, method, path, "audit.ts"].join("\0");
}

function auditApiMetadata(input: {
  actionName: Extract<
    AuditActionName,
    | "clockify_entity_changes_created"
    | "clockify_entity_changes_updated"
    | "clockify_entity_changes_deleted"
  >;
  operationId: string;
  path: string;
}): ApiActionMetadataCarrier {
  return Object.freeze({
    apiExposure: "api",
    apiOperation: Object.freeze({
      operationId: input.operationId,
      host: "api",
      method: "GET",
      path: input.path,
      access: "read",
      exposure: "api",
    }),
    adapterEndpoints: Object.freeze({
      primary: Object.freeze([auditEndpointKey("api", "GET", input.path)]),
      support: Object.freeze([]),
    }),
    availabilityByAuthClass: AUDIT_AVAILABLE_TO_BOTH,
    boundedArgumentDictionaries: Object.freeze([]),
    materialFields: Object.freeze([]),
    presentation: Object.freeze({ presenterId: input.actionName, version: 1 }),
  });
}

function auditInternalMetadata(input: {
  reason: string;
  primary: string;
  availability: AvailabilityByAuthClass;
  exposure?: "generic" | "composite";
}): ApiActionMetadataCarrier {
  return Object.freeze({
    apiExposure: input.exposure ?? "generic",
    apiExposureReason: input.reason,
    adapterEndpoints: Object.freeze({
      primary: Object.freeze([input.primary]),
      support: Object.freeze([]),
    }),
    availabilityByAuthClass: input.availability,
    boundedArgumentDictionaries: Object.freeze([]),
  });
}

const AUDIT_API_METADATA = Object.freeze({
  clockify_audit_logs_search: auditInternalMetadata({
    reason: "The official Clockify OpenAPI description contains audit-log schemas but no path or operation ID, so this adapter workflow stays internal until official operation identity exists.",
    primary: auditEndpointKey("audit", "POST", "/workspaces/{workspaceId}/audit-log"),
    availability: AUDIT_OPERATION_ID_MISSING,
  }),
  clockify_entity_changes_created: auditApiMetadata({
    actionName: "clockify_entity_changes_created",
    operationId: "getCreatedEntityInfo",
    path: "/workspaces/{workspaceId}/entities/created",
  }),
  clockify_entity_changes_updated: auditApiMetadata({
    actionName: "clockify_entity_changes_updated",
    operationId: "getUpdatedEntityInfo",
    path: "/workspaces/{workspaceId}/entities/updated",
  }),
  clockify_entity_changes_deleted: auditApiMetadata({
    actionName: "clockify_entity_changes_deleted",
    operationId: "getDeletedEntityInfo",
    path: "/workspaces/{workspaceId}/entities/deleted",
  }),
  clockify_entity_changes_list: auditInternalMetadata({
    reason: "Selects the created, updated, or deleted entity-change endpoint from changeType; superseded on MODEL_API by the three literal entity-change reads.",
    primary: auditEndpointKey("api", "GET", "/workspaces/{workspaceId}/entities/created"),
    availability: AUDIT_AVAILABLE_TO_BOTH,
  }),
} satisfies Readonly<Record<AuditActionName, ApiActionMetadataCarrier>>);

/** A representative subset of the audit-log action enum (Clockify accepts the full set). */
const auditAction = z.enum([
  "CREATE_TIME_PERSONAL_MANUAL", "UPDATE_TIME_PERSONAL", "DELETE_TIME_PERSONAL", "CREATE_TIME_FOR_OTHER",
  "CREATE_PROJECT", "UPDATE_PROJECT", "DELETE_PROJECT",
  "CREATE_TASK", "UPDATE_TASK", "DELETE_TASK",
  "CREATE_CLIENT", "UPDATE_CLIENT", "DELETE_CLIENT",
  "CREATE_TAG", "UPDATE_TAG", "DELETE_TAG",
  "CREATE_EXPENSE", "UPDATE_EXPENSE", "DELETE_EXPENSE",
]);

function capRows(rows: unknown[]): { data?: unknown[]; count: number; bytes: number; truncated: boolean } {
  const bytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
  return bytes > AUDIT_MAX_BYTES
    ? { count: rows.length, bytes, truncated: true }
    : { data: rows, count: rows.length, bytes, truncated: false };
}

/** Every audit action in the enum — the default when the planner names none. */
const ALL_AUDIT_ACTIONS = auditAction.options;

type EntityChangeType = "created" | "updated" | "deleted";

async function entityChangesReceipt(
  ctx: ActionContext,
  actionName: string,
  changeType: EntityChangeType,
) {
  const result = await ctx.clockify.listEntityChanges(changeType);
  const capped = capRows(result.rows);
  return listReceipt({
    action: actionName,
    entity: "audit_log",
    ids: { workspaceId: ctx.workspaceId },
    rows: capped.data ?? [],
    dataKey: "entities",
    count: capped.count,
    truncated: result.truncated || capped.truncated,
    data: { changeType, bytes: capped.bytes, inlineTruncated: capped.truncated },
    warnings: capped.truncated
      ? [{ code: "audit_truncated", message: `Change feed is ${capped.bytes} bytes, over the inline cap.` }]
      : undefined,
  });
}

const search = defineAction({
  name: "clockify_audit_logs_search",
  ...AUDIT_API_METADATA.clockify_audit_logs_search,
  description: "Search the workspace audit log for create/update/delete actions in a date range (≤31 days). Defaults to all tracked actions over the last 7 days when not specified.",
  featureGroup: AUD,
  risks: ["read"],
  // actions/start/end are optional: the planner often omits them (it can't see the
  // schema), so default to all actions over the last 7 days rather than dead-ending
  // on `invalid_args`. A provided (but empty) actions list is still rejected.
  schema: z.object({
    actions: z.array(auditAction).min(1).optional(),
    start: z.string().min(1).optional(),
    end: z.string().min(1).optional(),
    page: z.number().int().positive().optional(),
  }),
  async handler(ctx: ActionContext, args) {
    const end = args.end ?? (ctx.now ?? (() => new Date()))().toISOString();
    const start = args.start ?? new Date(Date.parse(end) - SEVEN_DAYS_MS).toISOString();
    const result = await ctx.clockify.searchAuditLog({
      actions: args.actions ?? ALL_AUDIT_ACTIONS,
      start,
      end,
      page: args.page,
    });
    const capped = capRows(result.rows);
    return {
      kind: "receipt",
      receipt: listReceipt({
        action: "clockify_audit_logs_search",
        entity: "audit_log",
        ids: { workspaceId: ctx.workspaceId },
        rows: capped.data ?? [],
        dataKey: "entries",
        count: capped.count,
        truncated: result.truncated || capped.truncated,
        data: { bytes: capped.bytes, inlineTruncated: capped.truncated },
        warnings: capped.truncated ? [{ code: "audit_truncated", message: `Audit result is ${capped.bytes} bytes, over the inline cap; narrow the date range or fewer actions.` }] : undefined,
      }),
    };
  },
});

const entityChangesCreated = defineReadAction({
  name: "clockify_entity_changes_created",
  ...AUDIT_API_METADATA.clockify_entity_changes_created,
  description: "List recently created entities (experimental change-tracking feed).",
  group: AUD,
  schema: z.object({}),
  handler: (ctx) => entityChangesReceipt(ctx, "clockify_entity_changes_created", "created"),
});

const entityChangesUpdated = defineReadAction({
  name: "clockify_entity_changes_updated",
  ...AUDIT_API_METADATA.clockify_entity_changes_updated,
  description: "List recently updated entities (experimental change-tracking feed).",
  group: AUD,
  schema: z.object({}),
  handler: (ctx) => entityChangesReceipt(ctx, "clockify_entity_changes_updated", "updated"),
});

const entityChangesDeleted = defineReadAction({
  name: "clockify_entity_changes_deleted",
  ...AUDIT_API_METADATA.clockify_entity_changes_deleted,
  description: "List recently deleted entities (experimental change-tracking feed).",
  group: AUD,
  schema: z.object({}),
  handler: (ctx) => entityChangesReceipt(ctx, "clockify_entity_changes_deleted", "deleted"),
});

const entityChanges = defineAction({
  name: "clockify_entity_changes_list",
  ...AUDIT_API_METADATA.clockify_entity_changes_list,
  description: "List recently created/updated/deleted entities (experimental change-tracking feed).",
  featureGroup: AUD,
  risks: ["read"],
  schema: z.object({ changeType: z.enum(["created", "updated", "deleted"]) }),
  async handler(ctx, args) {
    const receipt = await entityChangesReceipt(ctx, "clockify_entity_changes_list", args.changeType);
    return { kind: "receipt", receipt };
  },
});

export const AUDIT_ACTIONS: ActionDefinition[] = [
  search,
  entityChangesCreated,
  entityChangesUpdated,
  entityChangesDeleted,
  entityChanges,
];
