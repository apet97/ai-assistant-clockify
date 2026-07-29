import { createHash } from "node:crypto";
import { z } from "zod";
import { FEATURE_GROUPS, type FeatureGroup } from "../harness/permissions.js";
import type {
  PresentedResult,
  DiagnosticView,
  PresentedResultEnvelope,
} from "./presentation/presented-result.js";

export const RUN_EVENT_TYPES = [
  "run.started",
  "model.started",
  "model.completed",
  "api.search_started",
  "api.operations_loaded",
  "tool.requested",
  "tool.denied",
  "tool.started",
  "tool.completed",
  "operation.prepared",
  "operation.confirmed",
  "operation.started",
  "operation.completed",
  "clarification.required",
  "run.suspended",
  "run.completed",
  "run.failed",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

const MAX_UTF8_BYTES = 256;
const MAX_ARRAY = 12;
const MAX_PAYLOAD_BYTES = 65_536;

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

const boundedString = (maxBytes = MAX_UTF8_BYTES) =>
  z.string().refine((value) => utf8ByteLength(value) <= maxBytes, { message: "string_too_long" });

const boundedStringArray = (maxItems = MAX_ARRAY, maxBytes = MAX_UTF8_BYTES) =>
  z.array(boundedString(maxBytes)).max(maxItems);

const featureGroupSchema = z.enum(FEATURE_GROUPS as [FeatureGroup, ...FeatureGroup[]]);

const usageSchema = z.object({
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  estimatedTokens: z.number().int().nonnegative().optional(),
}).strict();

export const runEventPayloadSchemas = {
  "run.started": z.object({ requestHash: boundedString(64).refine((v) => v.length === 64) }).strict(),
  "model.started": z.object({
    modelCall: z.number().int().positive(),
    providerAttempt: z.union([z.literal(1), z.literal(2)]),
    loadedOperationIds: boundedStringArray(),
    cacheSeeded: z.boolean(),
  }).strict(),
  "model.completed": z.object({
    modelCall: z.number().int().positive(),
    providerAttempts: z.union([z.literal(1), z.literal(2)]),
    chatMessageId: boundedString().optional(),
    usage: usageSchema,
    latencyMs: z.number().int().nonnegative(),
  }).strict(),
  "api.search_started": z.object({
    searchIndex: z.number().int().positive(),
    access: z.enum(["read", "write", "any"]),
    groups: z.array(featureGroupSchema).max(FEATURE_GROUPS.length),
  }).strict(),
  "api.operations_loaded": z.object({
    operationIds: boundedStringArray(),
    source: z.enum(["cache", "discovery"]),
  }).strict(),
  "tool.requested": z.object({
    toolCallId: boundedString(),
    actionName: boundedString(),
    argumentsHash: boundedString(64).refine((v) => v.length === 64),
  }).strict(),
  "tool.denied": z.object({
    toolCallId: boundedString(),
    actionName: boundedString(),
    code: boundedString(),
    /** Links the canonical failure/denial result when one was persisted
     * (closure-plan PR 5 / F22) — absent for pure pre-dispatch denials. */
    actionResultId: boundedString().optional(),
  }).strict(),
  "tool.started": z.object({
    toolCallId: boundedString(),
    actionName: boundedString(),
  }).strict(),
  "tool.completed": z.object({
    toolCallId: boundedString(),
    actionName: boundedString(),
    actionResultId: boundedString(),
  }).strict(),
  "operation.prepared": z.object({
    operationId: boundedString(),
    confirmationId: boundedString(),
    batchId: boundedString().optional(),
  }).strict(),
  "operation.confirmed": z.object({
    operationId: boundedString(),
    confirmationId: boundedString(),
  }).strict(),
  "operation.started": z.object({ operationId: boundedString() }).strict(),
  "operation.completed": z.object({
    operationId: boundedString(),
    actionResultId: boundedString(),
  }).strict(),
  // `actionResultId` references the canonical clarify `action_results` row that
  // owns the admin-visible question text. Events keep bounded links, never the
  // prose (which carries Clockify entity names).
  "clarification.required": z.object({
    clarificationId: boundedString(),
    actionResultId: boundedString(),
  }).strict(),
  "run.suspended": z.object({
    reason: z.enum(["awaiting_confirmation", "awaiting_clarification"]),
  }).strict(),
  "run.completed": z.object({
    chatMessageId: boundedString().optional(),
    actionResultIds: boundedStringArray(),
  }).strict(),
  "run.failed": z.object({ code: boundedString() }).strict(),
} as const satisfies Record<RunEventType, z.ZodType>;

export type RunEventPayloadMap = {
  [K in RunEventType]: z.infer<(typeof runEventPayloadSchemas)[K]>;
};

export type RunEventView = {
  [K in RunEventType]: {
    eventType: K;
    payload: RunEventPayloadMap[K];
    createdAt: string;
  };
}[RunEventType];

export interface SequencedRunEvent {
  runId: string;
  sequence: number;
  event: RunEventView;
  attachment?: RunEventAttachment;
}

export type RunEventAttachment =
  | { kind: "assistant_message"; messageId: string; text: string }
  | { kind: "presented_result"; actionResultId: string; envelope: PresentedResultEnvelope }
  | { kind: "pending_confirmation"; confirmationId: string; envelope: PresentedResultEnvelope }
  | {
      kind: "pending_clarification";
      clarificationId: string;
      status: "pending" | "resolving";
      /** The admin-visible question, read from the canonical clarify
       * `action_results` row the event references (CP-B). */
      question: string;
      /** The exact raw-argument key an option resolves into, or the inert
       * `"selection"` marker for a clarify with no single owning argument.
       * Diagnostic only — the UI renders `question`. */
      missingField: string;
      /** Display data ONLY: `externalId` and the stored partial arguments never
       * leave the server. A chip submits `optionId`, never the label. */
      candidates: Array<{ optionId: string; label: string; referenceId?: string }>;
      expiresAt: string;
    };

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

// The ONE authoritative v2 result envelope is defined in
// `./presentation/presented-result.ts` (T15-A) — re-exported here so every
// existing `../assistant-v2/events.js` import path is unchanged. Do not
// redefine `PresentedResult`/`DiagnosticView`/`PresentedResultEnvelope`
// anywhere else.
export type { PresentedResult, DiagnosticView, PresentedResultEnvelope };

export type RunEventFrame = {
  type: "run_event";
  runId: string;
  sequence: number;
  event: RunEventView;
  attachment?: RunEventAttachment;
};

export type DoneFrame = { type: "done"; runId: string; lastSequence: number };

export type LocalTransportError = {
  type: "transport_error";
  code: string;
  message: string;
};

export interface RunScopeRef {
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  installationGeneration: number;
  authClass: import("../harness/api-operation.js").AuthClass;
}

export interface ListRunEventsInput {
  scope: RunScopeRef;
  runId: string;
  after: number;
  limit: number;
}

export interface RunEventPage {
  runId: string;
  events: SequencedRunEvent[];
  nextAfter: number;
  hasMore: boolean;
  lastSequence: number;
}

export interface RunEventViewPort {
  list(input: ListRunEventsInput): RunEventPage;
}

export function computeArgumentsHash(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(args), "utf8").digest("hex");
}

export function parseRunEventPayload<K extends RunEventType>(
  eventType: K,
  payload: unknown,
): RunEventPayloadMap[K] {
  const parsed = runEventPayloadSchemas[eventType].parse(payload) as RunEventPayloadMap[K];
  const encoded = JSON.stringify(parsed);
  if (utf8ByteLength(encoded) > MAX_PAYLOAD_BYTES) {
    throw new Error("run_event_payload_too_large");
  }
  return parsed;
}

export function encodeRunEventPayload<K extends RunEventType>(
  eventType: K,
  payload: RunEventPayloadMap[K],
): string {
  const parsed = parseRunEventPayload(eventType, payload);
  return JSON.stringify(parsed);
}
