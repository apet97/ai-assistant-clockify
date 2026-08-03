/**
 * Runtime boundary for untrusted same-origin API data. TypeScript types alone
 * cannot protect a deployed iframe when an old server, proxy, or partial deploy
 * sends a different shape. Keep this dependency-free so it can run before UI
 * mount and turn bad protocol data into an explicit, user-visible failure.
 */
import type { PublicProductLinks, UiPreferences } from "../shared/contracts.js";
import type {
  ChatResult,
  ConfirmResponse,
  HistoryResponse,
  OperationCardData,
  PolicyShape,
  ReceiptResult,
  StreamEvent,
} from "./shared.js";

const PROTOCOL_MESSAGE = "The assistant sent an invalid response. Please try again.";

export class ProtocolError extends Error {
  constructor(detail: string) {
    super(`Protocol error: ${detail}`);
  }
}

export function protocolErrorMessage(_error: unknown): string {
  return PROTOCOL_MESSAGE;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtocolError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new ProtocolError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return string(value, name);
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new ProtocolError(`${name} must be boolean`);
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ProtocolError(`${name} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = nonNegativeInteger(value, name);
  if (parsed === 0) throw new ProtocolError(`${name} must be positive`);
  return parsed;
}

function isoString(value: unknown, name: string): string {
  const parsed = string(value, name);
  if (Number.isNaN(Date.parse(parsed))) throw new ProtocolError(`${name} must be an ISO date`);
  return parsed;
}

function array<T>(value: unknown, name: string, decode: (item: unknown, name: string) => T): T[] {
  if (!Array.isArray(value)) throw new ProtocolError(`${name} must be an array`);
  return value.map((item, index) => decode(item, `${name}[${index}]`));
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new ProtocolError(`${name} must be an array`);
  return value.map((item, index) => string(item, `${name}[${index}]`));
}

function undoFrom(value: unknown, name = "result.undo"): { id: string } | undefined {
  if (value === undefined) return undefined;
  const undo = record(value, name);
  return { id: string(undo.id, `${name}.id`) };
}

function optionsFrom(value: unknown, name: string): Array<{ id: string; label: string }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ProtocolError(`${name} must be an array`);
  return value.map((option, index) => {
    const item = record(option, `${name}[${index}]`);
    return {
      id: string(item.id, `${name}[${index}].id`),
      label: string(item.label, `${name}[${index}].label`),
    };
  });
}

/** Decode the common JSON-envelope invariant used by every same-origin route. */
export function decodeApiEnvelope(value: unknown): Record<string, unknown> {
  const envelope = record(value, "API response");
  if (typeof envelope.ok !== "boolean") throw new ProtocolError("API response.ok must be boolean");
  return envelope;
}

export interface ApiFailure {
  ok: false;
  code?: string;
  message?: string;
}

export interface MeResponse {
  ok: true;
  workspaceId: string;
  adminUserId: string;
  workspaceRole: string;
  preferences: UiPreferences;
  links: PublicProductLinks;
  csrfToken: string;
}

export interface PermissionsResponse {
  ok: true;
  policy: PolicyShape;
  firstRun: boolean;
  featureGroups: string[];
}

export interface SessionsResponse {
  ok: true;
  sessions: Array<{
    id: string;
    title: string;
    messageCount: number;
    lastMessageAt: string;
    createdAt: string;
    current: boolean;
  }>;
}

/** A v2 chat turn's durable run-event page, embedded (not envelope-wrapped) in
 * `ChatResponse`/replay. Same shape `decodeRunEventsResponse` decodes at the
 * top level, minus the `ok` discriminator. */
export interface ChatRunEventsPage {
  runId: string;
  events: import("../shared/contracts.js").SequencedRunEvent[];
  nextAfter: number;
  hasMore: boolean;
  lastSequence: number;
}

export interface ChatResponse {
  ok: true;
  reply: { kind: string; text: string };
  results: ChatResult[];
  /** v2 only: the durable run id/event page for this turn, present so a JSON
   * response or same-request-id replay can render the same cards the NDJSON
   * stream would. Absent under v1 and absent when the turn produced no run
   * (e.g. a pure clarification-free single read is still tagged, but a hard
   * v1 rollback simply never sets it). */
  runId?: string;
  runEvents?: ChatRunEventsPage;
}

export interface UndoResponse {
  ok: boolean;
  code?: string;
  message?: string;
  receipt?: ReceiptResult["receipt"];
  persistenceDegraded?: boolean;
}

export interface PermissionSaveResponse {
  ok: boolean;
  code?: string;
  message?: string;
  receipt?: ReceiptResult["receipt"];
  policy?: PolicyShape;
}

export interface SimpleMutationResponse {
  ok: boolean;
  code?: string;
  message?: string;
  status?: "cancelled";
}

function failureFrom(envelope: Record<string, unknown>): ApiFailure {
  if (envelope.ok !== false) throw new ProtocolError("API response.ok must be false");
  const code = optionalString(envelope.code, "API response.code");
  const message = optionalString(envelope.message, "API response.message");
  return { ok: false, ...(code ? { code } : {}), ...(message ? { message } : {}) };
}

function policyFrom(value: unknown, name: string): PolicyShape {
  const policy = record(value, name);
  const rawGroups = record(policy.groups, `${name}.groups`);
  const groups: Record<string, string> = {};
  for (const [group, level] of Object.entries(rawGroups)) {
    if (level !== "off" && level !== "read" && level !== "read_write") {
      throw new ProtocolError(`${name}.groups.${group} has an unknown permission level`);
    }
    groups[group] = level;
  }
  return { version: positiveInteger(policy.version, `${name}.version`), groups };
}

function preferencesFrom(value: unknown, name: string): UiPreferences {
  const preferences = record(value, name);
  const theme = string(preferences.theme, `${name}.theme`);
  if (theme !== "system" && theme !== "light" && theme !== "dark") {
    throw new ProtocolError(`${name}.theme is unknown`);
  }
  const timeZone = optionalString(preferences.timeZone, `${name}.timeZone`);
  if (timeZone) {
    try {
      new Intl.DateTimeFormat(undefined, { timeZone }).format(0);
    } catch {
      throw new ProtocolError(`${name}.timeZone is invalid`);
    }
  }
  return { theme, ...(timeZone ? { timeZone } : {}) };
}

function httpsUrl(value: unknown, name: string): string {
  const raw = string(value, name);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ProtocolError(`${name} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:") throw new ProtocolError(`${name} must use HTTPS`);
  return parsed.toString();
}

/** Decode the authenticated bootstrap response before it reaches DOM state. */
export function decodeMeResponse(value: unknown): MeResponse | ApiFailure {
  const envelope = decodeApiEnvelope(value);
  if (!envelope.ok) return failureFrom(envelope);
  const links = record(envelope.links, "API response.links");
  const csrfToken = string(envelope.csrfToken, "API response.csrfToken");
  if (!csrfToken) throw new ProtocolError("API response.csrfToken must not be empty");
  return {
    ok: true,
    workspaceId: string(envelope.workspaceId, "API response.workspaceId"),
    adminUserId: string(envelope.adminUserId, "API response.adminUserId"),
    workspaceRole: string(envelope.workspaceRole, "API response.workspaceRole"),
    preferences: preferencesFrom(envelope.preferences, "API response.preferences"),
    links: {
      privacy: httpsUrl(links.privacy, "API response.links.privacy"),
      support: httpsUrl(links.support, "API response.links.support"),
      security: httpsUrl(links.security, "API response.links.security"),
    },
    csrfToken,
  };
}

/** Decode the per-admin feature policy used by first-run and settings. */
export function decodePermissionsResponse(value: unknown): PermissionsResponse | ApiFailure {
  const envelope = decodeApiEnvelope(value);
  if (!envelope.ok) return failureFrom(envelope);
  const featureGroups = stringArray(envelope.featureGroups, "API response.featureGroups");
  const policy = policyFrom(envelope.policy, "API response.policy");
  for (const group of featureGroups) {
    if (!(group in policy.groups)) throw new ProtocolError(`API response.policy.groups.${group} is missing`);
  }
  return {
    ok: true,
    policy,
    firstRun: boolean(envelope.firstRun, "API response.firstRun"),
    featureGroups,
  };
}

/** Decode only what the save flow needs from the permission preview response:
 * the confirm-binding token (T16-E — confirm never accepts a groups object). */
export function decodePermissionPreviewTokenResponse(value: unknown): { ok: true; previewToken: string } | ApiFailure {
  const envelope = decodeApiEnvelope(value);
  if (!envelope.ok) return failureFrom(envelope);
  const preview = record(envelope.preview, "API response.preview");
  return { ok: true, previewToken: string(preview.previewToken, "API response.preview.previewToken") };
}

function artifactFrom(data: unknown): NonNullable<ReceiptResult["receipt"]["artifact"]> {
  const payload = record(data, "receipt.data");
  if (payload.contentType !== "application/pdf") {
    throw new ProtocolError("receipt.data.contentType must be application/pdf");
  }
  const artifact = record(payload.artifact, "receipt.data.artifact");
  const downloadUrl = string(artifact.downloadUrl, "receipt.data.artifact.downloadUrl");
  if (!/^\/api\/artifacts\/[A-Za-z0-9_-]+$/.test(downloadUrl)) {
    throw new ProtocolError("receipt.data.artifact.downloadUrl must be a same-origin artifact path");
  }
  const filename = string(artifact.filename, "receipt.data.artifact.filename");
  const hasControlCharacter = [...filename].some((character) => character.charCodeAt(0) < 32);
  if (!filename.trim() || /[/\\]/.test(filename) || hasControlCharacter || !filename.toLowerCase().endsWith(".pdf")) {
    throw new ProtocolError("receipt.data.artifact.filename must be a safe PDF filename");
  }
  const expiresAt = string(artifact.expiresAt, "receipt.data.artifact.expiresAt");
  if (Number.isNaN(Date.parse(expiresAt))) throw new ProtocolError("receipt.data.artifact.expiresAt must be an ISO date");
  return { downloadUrl, filename, expiresAt };
}

function warningsFrom(value: unknown): Array<{ code?: string; message: string }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ProtocolError("result.receipt.warnings must be an array");
  return value.map((warning, index) => {
    const item = record(warning, `result.receipt.warnings[${index}]`);
    return {
      message: string(item.message, `result.receipt.warnings[${index}].message`),
      ...(optionalString(item.code, `result.receipt.warnings[${index}].code`) ? { code: item.code as string } : {}),
    };
  });
}

/** The full v2 `PresentedResult` status set (hand-maintained twin of
 * `PRESENTED_RESULT_STATUSES`; the operation/step status sets above are a
 * DIFFERENT enum). Shared by the strict run_event attachment gate and the
 * lenient legacy-receipt passthrough below. */
const PRESENTED_RESULT_STATUS_SET = new Set([
  "succeeded",
  "no_change_needed",
  "failed",
  "partial",
  "pending_confirmation",
  "cancelled",
  "outcome_unknown",
]);

/** Decode the receipt subset rendered by the UI, preserving unknown safe fields. */
export function decodeReceipt(value: unknown): ReceiptResult {
  const result = record(value, "result");
  if (result.kind !== "receipt") throw new ProtocolError("result.kind must be receipt");
  const raw = record(result.receipt, "result.receipt");
  if (typeof raw.ok !== "boolean") throw new ProtocolError("result.receipt.ok must be boolean");
  const action = string(raw.action, "result.receipt.action");
  const warnings = warningsFrom(raw.warnings);
  const receipt: ReceiptResult["receipt"] = {
    ok: raw.ok,
    action,
    ...(optionalString(raw.message, "result.receipt.message") ? { message: raw.message as string } : {}),
    ...(raw.changed === undefined ? {} : { changed: raw.changed }),
    ...(warnings ? { warnings } : {}),
    // Presentation-only status passthrough (readiness A5): a v2 history row
    // serialized by `chatReceiptFromEnvelope` carries the presented status, so
    // a reload renders the SAME header the live stream showed (e.g. "No change
    // needed", never a relapsed "Done — with notes"). A legacy v1 receipt
    // never sets the field; an unrecognized value degrades to the ok-boolean
    // rendering instead of rejecting the whole page — display-only data, so
    // fail-open is safe here (the strict run_event gate stays strict).
    ...(typeof raw.presentedStatus === "string" && PRESENTED_RESULT_STATUS_SET.has(raw.presentedStatus)
      ? { presentedStatus: raw.presentedStatus as ReceiptResult["receipt"]["presentedStatus"] }
      : {}),
  };
  if (raw.ok && action === "clockify_invoices_export") {
    if (raw.data === undefined) throw new ProtocolError("receipt.data is required after invoice export");
    receipt.artifact = artifactFrom(raw.data);
  }
  const undo = undoFrom(result.undo);
  return { kind: "receipt", receipt, ...(undo ? { undo } : {}) };
}

export function decodeResult(value: unknown): ChatResult {
  const result = record(value, "result");
  if (result.kind === "receipt") return decodeReceipt(result);
  if (result.kind === "clarify") {
    const options = optionsFrom(result.options, "result.options");
    return {
      kind: "clarify",
      message: string(result.message, "result.message"),
      ...(options ? { options } : {}),
    };
  }
  if (result.kind === "preview") {
    const preview = record(result.preview, "result.preview");
    const expiresAt = optionalString(result.expiresAt, "result.expiresAt");
    if (expiresAt !== undefined && Number.isNaN(Date.parse(expiresAt))) {
      throw new ProtocolError("result.expiresAt must be an ISO date");
    }
    let targets: Array<{ type: string; id: string; name?: string }> | undefined;
    if (preview.targets !== undefined) {
      if (!Array.isArray(preview.targets)) throw new ProtocolError("result.preview.targets must be an array");
      targets = preview.targets.map((target, index) => {
        const item = record(target, `result.preview.targets[${index}]`);
        const name = optionalString(item.name, `result.preview.targets[${index}].name`);
        return {
          type: string(item.type, `result.preview.targets[${index}].type`),
          id: string(item.id, `result.preview.targets[${index}].id`),
          ...(name ? { name } : {}),
        };
      });
    }
    const featureGroup = optionalString(preview.featureGroup, "result.preview.featureGroup");
    return {
      kind: "preview",
      previewId: string(result.previewId, "result.previewId"),
      nonce: string(result.nonce, "result.nonce"),
      ...(expiresAt ? { expiresAt } : {}),
      preview: {
        actionLabel: string(preview.actionLabel, "result.preview.actionLabel"),
        expectedChanges: stringArray(preview.expectedChanges, "result.preview.expectedChanges"),
        reversibility: string(preview.reversibility, "result.preview.reversibility"),
        warnings: stringArray(preview.warnings, "result.preview.warnings"),
        ...(featureGroup ? { featureGroup } : {}),
        ...(preview.riskLabels === undefined
          ? {}
          : { riskLabels: stringArray(preview.riskLabels, "result.preview.riskLabels") }),
        ...(targets ? { targets } : {}),
      },
    };
  }
  if (result.kind === "partial") {
    const recovery = record(result.recovery, "result.recovery");
    const retryable = recovery.retryable;
    if (retryable !== undefined && typeof retryable !== "boolean") {
      throw new ProtocolError("result.recovery.retryable must be boolean");
    }
    const options = optionsFrom(result.options, "result.options");
    const undo = undoFrom(result.undo);
    return {
      kind: "partial",
      receipt: decodeReceipt({ kind: "receipt", receipt: result.receipt }).receipt,
      message: string(result.message, "result.message"),
      recovery: {
        hint: string(recovery.hint, "result.recovery.hint"),
        ...(retryable === undefined ? {} : { retryable }),
      },
      ...(options ? { options } : {}),
      ...(undo ? { undo } : {}),
    };
  }
  throw new ProtocolError("result.kind is unknown");
}

function operationFrom(value: unknown, name: string): OperationCardData {
  const operation = record(value, name);
  const status = string(operation.status, `${name}.status`);
  const allowedStatuses = new Set([
    "prepared",
    "executing",
    "succeeded",
    "partial",
    "definitive_failed",
    "outcome_unknown",
  ]);
  if (!allowedStatuses.has(status)) throw new ProtocolError(`${name}.status is unknown`);
  const rawSteps = array(operation.steps, `${name}.steps`, (step, stepName) => {
    const item = record(step, stepName);
    const stepStatus = string(item.status, `${stepName}.status`);
    const allowedStepStatuses = new Set([
      "prepared",
      "executing",
      "succeeded",
      "definitive_failed",
      "outcome_unknown",
      "compensating",
      "compensated",
      "compensation_failed",
      "skipped",
    ]);
    if (!allowedStepStatuses.has(stepStatus)) throw new ProtocolError(`${stepName}.status is unknown`);
    return {
      planStepId: string(item.planStepId, `${stepName}.planStepId`),
      name: string(item.name, `${stepName}.name`),
      status: stepStatus,
    };
  });
  let reconciliation: OperationCardData["reconciliation"];
  if (operation.reconciliation !== undefined) {
    const raw = record(operation.reconciliation, `${name}.reconciliation`);
    const authoritative = raw.authoritative === undefined
      ? undefined
      : boolean(raw.authoritative, `${name}.reconciliation.authoritative`);
    const reason = optionalString(raw.reason, `${name}.reconciliation.reason`);
    reconciliation = {
      ...(authoritative === undefined ? {} : { authoritative }),
      ...(reason === undefined ? {} : { reason }),
    };
  }
  const stepsTruncated = operation.stepsTruncated === undefined
    ? undefined
    : boolean(operation.stepsTruncated, `${name}.stepsTruncated`);
  const createdAt = operation.createdAt === undefined ? undefined : isoString(operation.createdAt, `${name}.createdAt`);
  const updatedAt = operation.updatedAt === undefined ? undefined : isoString(operation.updatedAt, `${name}.updatedAt`);
  return {
    id: string(operation.id, `${name}.id`),
    actionName: string(operation.actionName, `${name}.actionName`),
    status: status as OperationCardData["status"],
    steps: rawSteps,
    ...(stepsTruncated === undefined ? {} : { stepsTruncated }),
    ...(reconciliation ? { reconciliation } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/** Decode the complete restore payload, including every nested result/card. */
export function decodeHistoryResponse(value: unknown): (HistoryResponse & { ok: true }) | ApiFailure {
  const envelope = decodeApiEnvelope(value);
  if (!envelope.ok) return failureFrom(envelope);
  const messages = array(envelope.messages, "API response.messages", (message, name) => {
    const item = record(message, name);
    const role = string(item.role, `${name}.role`);
    if (role !== "user" && role !== "assistant") throw new ProtocolError(`${name}.role is unknown`);
    const results = item.results === undefined
      ? undefined
      : array(item.results, `${name}.results`, (result) => decodeResult(result));
    return {
      role,
      content: string(item.content, `${name}.content`),
      ...(results ? { results } : {}),
    };
  });
  const pendingPreviews = array(envelope.pendingPreviews, "API response.pendingPreviews", (preview, name) => {
    const decoded = decodeResult(preview);
    if (decoded.kind !== "preview") throw new ProtocolError(`${name}.kind must be preview`);
    return decoded;
  });
  const operationRuns = envelope.operationRuns === undefined
    ? undefined
    : array(envelope.operationRuns, "API response.operationRuns", operationFrom);
  const activeRun = envelope.activeRun === undefined
    ? undefined
    : (() => {
        const run = record(envelope.activeRun, "API response.activeRun");
        return {
          runId: string(run.runId, "API response.activeRun.runId"),
          phase: string(run.phase, "API response.activeRun.phase"),
          lastSequence: positiveInteger(run.lastSequence, "API response.activeRun.lastSequence"),
          updatedAt: isoString(run.updatedAt, "API response.activeRun.updatedAt"),
        };
      })();
  return {
    ok: true,
    messages,
    pendingPreviews,
    ...(operationRuns ? { operationRuns } : {}),
    ...(activeRun ? { activeRun } : {}),
  };
}

/** Decode the conversation switcher list before rendering untrusted titles. */
export function decodeSessionsResponse(value: unknown): SessionsResponse | ApiFailure {
  const envelope = decodeApiEnvelope(value);
  if (!envelope.ok) return failureFrom(envelope);
  const sessions = array(envelope.sessions, "API response.sessions", (session, name) => {
    const item = record(session, name);
    return {
      id: string(item.id, `${name}.id`),
      title: string(item.title, `${name}.title`),
      messageCount: nonNegativeInteger(item.messageCount, `${name}.messageCount`),
      lastMessageAt: isoString(item.lastMessageAt, `${name}.lastMessageAt`),
      createdAt: isoString(item.createdAt, `${name}.createdAt`),
      current: boolean(item.current, `${name}.current`),
    };
  });
  return { ok: true, sessions };
}

/** Decode the maintained non-streaming turn response. `runId`/`runEvents` are
 * OPTIONAL (v1 never sends them; a v2 turn with nothing to attach may omit
 * `runEvents` too) but, when present, `runEvents` is decoded with the exact
 * strict decoder the NDJSON/run-events paths use — a malformed page throws
 * `ProtocolError` rather than being silently dropped. */
export function decodeChatResponse(value: unknown): ChatResponse | ApiFailure {
  const envelope = decodeApiEnvelope(value);
  if (!envelope.ok) return failureFrom(envelope);
  const reply = record(envelope.reply, "API response.reply");
  const runId = optionalString(envelope.runId, "API response.runId");
  const runEvents = envelope.runEvents === undefined
    ? undefined
    : decodeRunEventsPage(record(envelope.runEvents, "API response.runEvents"), "API response.runEvents");
  return {
    ok: true,
    reply: {
      kind: string(reply.kind, "API response.reply.kind"),
      text: string(reply.text, "API response.reply.text"),
    },
    results: array(envelope.results, "API response.results", (result) => decodeResult(result)),
    ...(runId ? { runId } : {}),
    ...(runEvents ? { runEvents } : {}),
  };
}

function receiptFrom(value: unknown): ReceiptResult["receipt"] {
  return decodeReceipt({ kind: "receipt", receipt: value }).receipt;
}

/** Decode a button-only confirmation response, including truthful partials/resume. */
export function decodeConfirmResponse(value: unknown): ConfirmResponse {
  const envelope = decodeApiEnvelope(value);
  const base = envelope.ok ? { ok: true as const } : failureFrom(envelope);
  const persistenceDegraded = envelope.persistenceDegraded === undefined
    ? undefined
    : boolean(envelope.persistenceDegraded, "API response.persistenceDegraded");
  const receipt = envelope.receipt === undefined ? undefined : receiptFrom(envelope.receipt);
  if (envelope.ok && !receipt) throw new ProtocolError("API response.receipt is required after confirmation");
  let partial: ConfirmResponse["result"];
  if (envelope.result !== undefined) {
    const decoded = decodeResult(envelope.result);
    if (decoded.kind !== "partial") throw new ProtocolError("API response.result must be partial");
    partial = decoded;
  }
  const undo = undoFrom(envelope.undo, "API response.undo");
  let resume: ConfirmResponse["resume"];
  if (envelope.resume !== undefined) {
    const raw = record(envelope.resume, "API response.resume");
    const reply = record(raw.reply, "API response.resume.reply");
    resume = {
      reply: {
        kind: string(reply.kind, "API response.resume.reply.kind"),
        text: string(reply.text, "API response.resume.reply.text"),
      },
      results: array(raw.results, "API response.resume.results", (result) => decodeResult(result)),
    };
  }
  return {
    ...base,
    ...(receipt ? { receipt } : {}),
    ...(partial ? { result: partial } : {}),
    ...(undo ? { undo } : {}),
    ...(resume ? { resume } : {}),
    ...(persistenceDegraded === undefined ? {} : { persistenceDegraded }),
  };
}

/** Decode an undo response without flattening a failed reversal's receipt. */
export function decodeUndoResponse(value: unknown): UndoResponse {
  const envelope = decodeApiEnvelope(value);
  const base = envelope.ok ? { ok: true as const } : failureFrom(envelope);
  const receipt = envelope.receipt === undefined ? undefined : receiptFrom(envelope.receipt);
  if (envelope.ok && !receipt) throw new ProtocolError("API response.receipt is required after undo");
  const persistenceDegraded = envelope.persistenceDegraded === undefined
    ? undefined
    : boolean(envelope.persistenceDegraded, "API response.persistenceDegraded");
  return {
    ...base,
    ...(receipt ? { receipt } : {}),
    ...(persistenceDegraded === undefined ? {} : { persistenceDegraded }),
  };
}

/** Decode permission-save success/failure bodies. */
export function decodePermissionSaveResponse(value: unknown): PermissionSaveResponse {
  const envelope = decodeApiEnvelope(value);
  if (!envelope.ok) return failureFrom(envelope);
  return {
    ok: true,
    receipt: receiptFrom(envelope.receipt),
    policy: policyFrom(envelope.policy, "API response.policy"),
  };
}

/** Decode new/open/cancel responses; cancel success is explicitly distinguished. */
export function decodeSimpleMutationResponse(
  value: unknown,
  expectedStatus?: "cancelled",
): SimpleMutationResponse {
  const envelope = decodeApiEnvelope(value);
  if (!envelope.ok) return failureFrom(envelope);
  if (expectedStatus && envelope.status !== expectedStatus) {
    throw new ProtocolError(`API response.status must be ${expectedStatus}`);
  }
  return { ok: true, ...(expectedStatus ? { status: expectedStatus } : {}) };
}

/** One settled member of an aggregate batch confirm (id + terminal status). */
export interface ConfirmBatchItem {
  confirmationId: string;
  status: string;
}

/** Decode POST /api/confirmation-batches/:id/confirm (aggregate, non-stream). */
export function decodeConfirmBatchResponse(
  value: unknown,
): { ok: true; status: string; items: ConfirmBatchItem[] } | ApiFailure {
  const envelope = decodeApiEnvelope(value);
  if (!envelope.ok) return failureFrom(envelope);
  const rawItems = envelope.items;
  if (!Array.isArray(rawItems)) throw new ProtocolError("API response.items must be an array");
  const items = rawItems.map((item, index) => {
    const row = record(item, `API response.items[${index}]`);
    return {
      confirmationId: string(row.confirmationId, `API response.items[${index}].confirmationId`),
      status: string(row.status, `API response.items[${index}].status`),
    };
  });
  return { ok: true, status: string(envelope.status, "API response.status"), items };
}

/** Decode the passive operation-status route's rendered subset. */
export function decodeOperationResponse(value: unknown): { ok: true; operation: OperationCardData } | ApiFailure {
  const envelope = decodeApiEnvelope(value);
  if (!envelope.ok) return failureFrom(envelope);
  return { ok: true, operation: operationFrom(envelope.operation, "API response.operation") };
}

/** Decode a complete NDJSON event before it enters the composer state machine. */
export function decodeNdjsonEvent(value: unknown): StreamEvent {
  const event = record(value, "stream event");
  const type = string(event.type, "stream event.type");
  if (type === "reply") return { type, text: string(event.text, "stream event.text"), ...(optionalString(event.kind, "stream event.kind") ? { kind: event.kind as string } : {}) };
  if (type === "result") {
    const persistenceDegraded = event.persistenceDegraded === undefined
      ? undefined
      : boolean(event.persistenceDegraded, "stream event.persistenceDegraded");
    return {
      type,
      result: decodeResult(event.result),
      ...(persistenceDegraded === undefined ? {} : { persistenceDegraded }),
    };
  }
  if (type === "receipt") {
    const undo = undoFrom(event.undo, "stream event.undo");
    const persistenceDegraded = event.persistenceDegraded === undefined
      ? undefined
      : boolean(event.persistenceDegraded, "stream event.persistenceDegraded");
    return {
      type,
      receipt: decodeReceipt({ kind: "receipt", receipt: event.receipt }).receipt,
      ...(undo ? { undo } : {}),
      ...(persistenceDegraded === undefined ? {} : { persistenceDegraded }),
    };
  }
  if (type === "error") return { type, message: string(event.message, "stream event.message"), ...(optionalString(event.code, "stream event.code") ? { code: event.code as string } : {}) };
  if (type === "status") return { type, label: string(event.label, "stream event.label"), ...(optionalString(event.action, "stream event.action") ? { action: event.action as string } : {}) };
  if (type === "run_event") {
    const runId = string(event.runId, "stream event.runId");
    const sequence = positiveInteger(event.sequence, "stream event.sequence");
    const payload = record(event.event, "stream event.event");
    const eventType = string(payload.eventType, "stream event.event.eventType");
    const createdAt = isoString(payload.createdAt, "stream event.event.createdAt");
    const eventPayload = record(payload.payload, "stream event.event.payload");
    const attachment = event.attachment === undefined
      ? undefined
      : decodeRunEventAttachment(event.attachment);
    return {
      type,
      runId,
      sequence,
      event: { eventType, payload: eventPayload, createdAt } as import("../shared/contracts.js").RunEventView,
      ...(attachment ? { attachment } : {}),
    };
  }
  if (type === "done") {
    if (event.runId !== undefined && event.lastSequence !== undefined) {
      return {
        type,
        runId: string(event.runId, "stream event.runId"),
        lastSequence: positiveInteger(event.lastSequence, "stream event.lastSequence"),
      };
    }
    return { type };
  }
  throw new ProtocolError("stream event.type is unknown");
}

function presentedFactsFrom(value: unknown, name: string): Array<{ label: string; value: string }> {
  return array(value, name, (item, n) => {
    const r = record(item, n);
    return { label: string(r.label, `${n}.label`), value: string(r.value, `${n}.value`) };
  });
}

function presentedWarningsFrom(value: unknown, name: string): Array<{ code: string; message: string }> {
  return array(value, name, (item, n) => {
    const r = record(item, n);
    return { code: string(r.code, `${n}.code`), message: string(r.message, `${n}.message`) };
  });
}

function presentedReferencesFrom(
  value: unknown,
  name: string,
): import("../shared/contracts.js").PresentedResult["references"] {
  return array(value, name, (item, n) => {
    const r = record(item, n);
    const status = string(r.status, `${n}.status`);
    if (status !== "active" && status !== "stale" && status !== "deleted") throw new ProtocolError(`${n}.status is unknown`);
    const bindingsRaw = record(r.bindings, `${n}.bindings`);
    const bindings: Record<string, string> = {};
    for (const [key, entry] of Object.entries(bindingsRaw)) bindings[key] = string(entry, `${n}.bindings.${key}`);
    return {
      id: string(r.id, `${n}.id`),
      conversationId: string(r.conversationId, `${n}.conversationId`),
      entityType: string(r.entityType, `${n}.entityType`),
      externalId: string(r.externalId, `${n}.externalId`),
      displayName: string(r.displayName, `${n}.displayName`),
      sourceRunId: string(r.sourceRunId, `${n}.sourceRunId`),
      bindings,
      status,
      verifiedAt: string(r.verifiedAt, `${n}.verifiedAt`),
    };
  });
}

function presentedRecoveryFrom(
  value: unknown,
  name: string,
): import("../shared/contracts.js").PresentedResult["recovery"] {
  if (value === undefined) return undefined;
  const recovery = record(value, name);
  const kind = string(recovery.kind, `${name}.kind`);
  const label = string(recovery.label, `${name}.label`);
  if (kind === "view_operation") return { kind, label, operationId: string(recovery.operationId, `${name}.operationId`) };
  if (kind === "retry_read") return { kind, label, readAttemptId: string(recovery.readAttemptId, `${name}.readAttemptId`) };
  if (kind === "start_new_chat") return { kind, label };
  throw new ProtocolError(`${name}.kind is unknown`);
}

function presentedDiagnosticFrom(
  value: unknown,
  name: string,
): import("../shared/contracts.js").PresentedResultEnvelope["diagnostic"] {
  if (value === undefined) return undefined;
  const diagnostic = record(value, name);
  if (diagnostic.kind !== "sanitized_receipt") throw new ProtocolError(`${name}.kind must be sanitized_receipt`);
  return {
    kind: "sanitized_receipt",
    byteLength: nonNegativeInteger(diagnostic.byteLength, `${name}.byteLength`),
    value: diagnostic.value as import("../shared/contracts.js").JsonValue,
  };
}

function decodeRunEventAttachment(value: unknown): import("../shared/contracts.js").RunEventAttachment {
  const attachment = record(value, "stream event.attachment");
  const kind = string(attachment.kind, "stream event.attachment.kind");
  if (kind === "assistant_message") {
    return {
      kind,
      messageId: string(attachment.messageId, "stream event.attachment.messageId"),
      text: string(attachment.text, "stream event.attachment.text"),
    };
  }
  if (kind === "presented_result" || kind === "pending_confirmation") {
    const envelope = record(attachment.envelope, "stream event.attachment.envelope");
    const presentation = record(envelope.presentation, "stream event.attachment.envelope.presentation");
    const status = string(presentation.status, "stream event.attachment.envelope.presentation.status");
    if (!PRESENTED_RESULT_STATUS_SET.has(status)) throw new ProtocolError("stream event.attachment.envelope.presentation.status is unknown");
    const recovery = presentedRecoveryFrom(presentation.recovery, "stream event.attachment.envelope.presentation.recovery");
    const decodedEnvelope = {
      presentation: {
        status: status as import("../shared/contracts.js").PresentedResult["status"],
        title: string(presentation.title, "stream event.attachment.envelope.presentation.title"),
        summary: string(presentation.summary, "stream event.attachment.envelope.presentation.summary"),
        facts: presentedFactsFrom(presentation.facts, "stream event.attachment.envelope.presentation.facts"),
        warnings: presentedWarningsFrom(presentation.warnings, "stream event.attachment.envelope.presentation.warnings"),
        references: presentedReferencesFrom(presentation.references, "stream event.attachment.envelope.presentation.references"),
        ...(recovery ? { recovery } : {}),
      },
      ...(typeof envelope.actionResultId === "string" ? { actionResultId: envelope.actionResultId } : {}),
      ...(envelope.confirmation && typeof envelope.confirmation === "object"
        ? {
            confirmation: {
              id: string((envelope.confirmation as Record<string, unknown>).id, "stream event.attachment.envelope.confirmation.id"),
              nonce: string((envelope.confirmation as Record<string, unknown>).nonce, "stream event.attachment.envelope.confirmation.nonce"),
              expiresAt: isoString((envelope.confirmation as Record<string, unknown>).expiresAt, "stream event.attachment.envelope.confirmation.expiresAt"),
              ...(typeof (envelope.confirmation as Record<string, unknown>).batchId === "string"
                ? { batchId: (envelope.confirmation as Record<string, unknown>).batchId as string }
                : {}),
            },
          }
        : {}),
      ...(envelope.diagnostic !== undefined
        ? { diagnostic: presentedDiagnosticFrom(envelope.diagnostic, "stream event.attachment.envelope.diagnostic") }
        : {}),
    };
    if (kind === "presented_result") {
      return {
        kind,
        actionResultId: string(attachment.actionResultId, "stream event.attachment.actionResultId"),
        envelope: decodedEnvelope,
      };
    }
    return {
      kind,
      confirmationId: string(attachment.confirmationId, "stream event.attachment.confirmationId"),
      envelope: decodedEnvelope,
    };
  }
  if (kind === "pending_clarification") {
    return {
      kind,
      clarificationId: string(attachment.clarificationId, "stream event.attachment.clarificationId"),
      status: string(attachment.status, "stream event.attachment.status") as "pending" | "resolving",
      question: string(attachment.question, "stream event.attachment.question"),
      missingField: string(attachment.missingField, "stream event.attachment.missingField"),
      candidates: array(attachment.candidates, "stream event.attachment.candidates", (candidate, name) => {
        const item = record(candidate, name);
        return {
          optionId: string(item.optionId, `${name}.optionId`),
          label: string(item.label, `${name}.label`),
          ...(typeof item.referenceId === "string" ? { referenceId: item.referenceId } : {}),
        };
      }),
      expiresAt: isoString(attachment.expiresAt, "stream event.attachment.expiresAt"),
    };
  }
  throw new ProtocolError("stream event.attachment.kind is unknown");
}

/**
 * Decode the run-id/events/paging fields shared by the scoped run-events
 * route's envelope AND the embedded page a v2 `ChatResponse` carries — the
 * SAME strict decoding either way (T08: no second, looser parser for the
 * JSON-fallback/replay path).
 */
function decodeRunEventsPage(source: Record<string, unknown>, name: string): ChatRunEventsPage {
  const events = array(source.events, `${name}.events`, (entry, entryName) => {
    const item = record(entry, entryName);
    const eventRecord = record(item.event, `${entryName}.event`);
    return {
      runId: string(item.runId, `${entryName}.runId`),
      sequence: positiveInteger(item.sequence, `${entryName}.sequence`),
      event: {
        eventType: string(eventRecord.eventType, `${entryName}.event.eventType`),
        payload: eventRecord.payload,
        createdAt: isoString(eventRecord.createdAt, `${entryName}.event.createdAt`),
      } as import("../shared/contracts.js").RunEventView,
      ...(item.attachment === undefined ? {} : { attachment: decodeRunEventAttachment(item.attachment) }),
    };
  });
  return {
    runId: string(source.runId, `${name}.runId`),
    events,
    nextAfter: positiveInteger(source.nextAfter, `${name}.nextAfter`),
    hasMore: boolean(source.hasMore, `${name}.hasMore`),
    lastSequence: positiveInteger(source.lastSequence, `${name}.lastSequence`),
  };
}

/** Decode one scoped run-event page for UI restoration. */
export function decodeRunEventsResponse(value: unknown): import("./shared.js").RunEventPageResponse | ApiFailure {
  const envelope = decodeApiEnvelope(value);
  if (!envelope.ok) return failureFrom(envelope);
  return { ok: true, ...decodeRunEventsPage(envelope, "API response") };
}
