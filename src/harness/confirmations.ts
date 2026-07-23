import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ActionOrigin,
  AuthorityModel,
  ExecutorKind,
  RegistryId,
} from "./action-discriminators.js";
import type { RiskLabel } from "./risk.js";
import { exactNonsecretJson } from "./safe-json.js";

/**
 * One-use risky-write confirmation lifecycle (SPEC "Confirmation Rules",
 * SAFETY_AND_PERMISSIONS "Confirmation Token"). These are pure functions over a
 * record shaped like the `pending_confirmations` row; the store persists them.
 *
 * The exact operation payload to execute is stored server-side and never
 * reconstructed from chat text. Confirmation is button-only: the page sends back
 * an opaque nonce whose hash must match the stored hash.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export type PendingStatus =
  | "pending"
  | "executing"
  | "succeeded"
  | "partial"
  | "definitive_failed"
  | "outcome_unknown"
  | "cancelled"
  | "expired";

export interface PendingConfirmationRecord {
  id: string;
  operationId: string;
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  status: PendingStatus;
  risk: RiskLabel[];
  preview: unknown;
  operation: unknown;
  /** Missing only on legacy previews, which the commit route rejects closed. */
  installationGeneration?: number;
  operationHash: string;
  targetFingerprints: string[];
  actionFingerprint: string;
  catalogHash: string;
  /** Persisted intent authority. Missing on legacy previews, which fail closed. */
  capabilityId?: string;
  capabilityHash?: string;
  nonceHash: string;
  expiresAt: string;
  createdAt: string;
  usedAt?: string;
  result?: unknown;
  /**
   * Suspended agentic-turn state (Phase 3): the loop transcript + the risky tool
   * call this preview answers, validated/consumed by the assistant layer
   * (`parseAgentState`). Absent for single-turn previews — those confirm exactly
   * as before.
   */
  agentState?: unknown;
  actionResultId?: string;
  /** Closed origin/registry/authority/executor tuple. Missing only on unreadable legacy rows. */
  origin?: ActionOrigin;
  registryId?: RegistryId;
  authorityModel?: AuthorityModel;
  executorKind?: ExecutorKind;
  runId?: string;
  batchId?: string;
}

export interface CreateConfirmationInput {
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  risk: RiskLabel[];
  preview: unknown;
  operation: unknown;
  /** Bind the preview to the exact installation token generation. */
  installationGeneration?: number;
  sessionSecret: string;
  now?: Date;
  ttlMs?: number;
  /** Injectable for deterministic tests. */
  id?: string;
  nonce?: string;
  /** Suspended agentic-turn state to persist with the preview (Phase 3). */
  agentState?: unknown;
  actionFingerprint?: string;
  catalogHash?: string;
  capabilityId?: string;
  capabilityHash?: string;
  origin?: ActionOrigin;
  registryId?: RegistryId;
  authorityModel?: AuthorityModel;
  executorKind?: ExecutorKind;
  runId?: string;
  batchId?: string;
  /** v2 assistant previews bind nonce/hash to the persisted operation_run payload hash. */
  operationBindingHash?: string;
}

export interface CreatedConfirmation {
  record: PendingConfirmationRecord;
  previewId: string;
  /** Raw nonce handed to the page state; only its hash is stored. */
  nonce: string;
  expiresAt: string;
}

export interface ConfirmPendingInput {
  record: PendingConfirmationRecord;
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  nonce: string;
  sessionSecret: string;
  now?: Date;
  expectedActionFingerprint?: string;
  expectedCatalogHash?: string;
}

export type ConfirmPendingResult =
  | { ok: true; record: PendingConfirmationRecord }
  | { ok: false; code: string; message: string };

export interface CancelPendingInput {
  record: PendingConfirmationRecord;
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  now?: Date;
}

export type CancelPendingResult =
  | { ok: true; record: PendingConfirmationRecord }
  | { ok: false; code: string; message: string };

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortValue(item));
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const next = (value as Record<string, unknown>)[key];
    if (next !== undefined) sorted[key] = sortValue(next);
  }
  return sorted;
}

export function hashOperation(operation: unknown): string {
  return createHash("sha256").update(canonicalJson(operation)).digest("hex");
}

/**
 * Bind the nonce hash to this specific preview (id + operationHash) and the
 * session secret, so a leaked nonce is useless against any other preview.
 */
function hashNonce(
  nonce: string,
  id: string,
  operationHash: string,
  sessionSecret: string,
): string {
  return createHash("sha256")
    .update(`${nonce}.${id}.${operationHash}.${sessionSecret}`)
    .digest("hex");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function createPendingConfirmation(input: CreateConfirmationInput): CreatedConfirmation {
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const id = input.id ?? randomUUID();
  const nonce = input.nonce ?? randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const operation = input.installationGeneration === undefined ||
      !input.operation || typeof input.operation !== "object" || Array.isArray(input.operation)
    ? input.operation
    : { ...input.operation as Record<string, unknown>, installationGeneration: input.installationGeneration };
  const recordForHash: PendingConfirmationRecord = {
    id,
    operationId: randomUUID(),
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    adminUserId: input.adminUserId,
    status: "pending",
    risk: input.risk,
    preview: input.preview,
    operation,
    ...(input.installationGeneration === undefined
      ? {}
      : { installationGeneration: input.installationGeneration }),
    operationHash: "",
    targetFingerprints: [],
    actionFingerprint: input.actionFingerprint ?? hashOperation({ operation, version: 1 }),
    catalogHash: input.catalogHash ?? "unbound",
    nonceHash: "",
    expiresAt: "",
    createdAt: "",
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.registryId ? { registryId: input.registryId } : {}),
    ...(input.authorityModel ? { authorityModel: input.authorityModel } : {}),
    ...(input.executorKind ? { executorKind: input.executorKind } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.batchId ? { batchId: input.batchId } : {}),
  };
  const operationHash = input.operationBindingHash ?? confirmationOperationBindingHash(recordForHash);
  const previewTargets = (input.preview as { targets?: unknown[] } | undefined)?.targets ?? [];

  const suppliedOperationId = operation && typeof operation === "object"
    ? (operation as { operationId?: unknown }).operationId
    : undefined;
  const record: PendingConfirmationRecord = {
    id,
    operationId: typeof suppliedOperationId === "string" ? suppliedOperationId : randomUUID(),
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    adminUserId: input.adminUserId,
    status: "pending",
    risk: input.risk,
    preview: input.preview,
    operation,
    ...(input.installationGeneration === undefined
      ? {}
      : { installationGeneration: input.installationGeneration }),
    operationHash,
    targetFingerprints: previewTargets.map((target) => hashOperation(target)),
    actionFingerprint: input.actionFingerprint ?? hashOperation({ operation, version: 1 }),
    catalogHash: input.catalogHash ?? "unbound",
    ...(input.capabilityId ? { capabilityId: input.capabilityId } : {}),
    ...(input.capabilityHash ? { capabilityHash: input.capabilityHash } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.registryId ? { registryId: input.registryId } : {}),
    ...(input.authorityModel ? { authorityModel: input.authorityModel } : {}),
    ...(input.executorKind ? { executorKind: input.executorKind } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.batchId ? { batchId: input.batchId } : {}),
    nonceHash: hashNonce(nonce, id, operationHash, input.sessionSecret),
    expiresAt,
    createdAt: now.toISOString(),
    agentState: input.agentState,
  };

  return { record, previewId: id, nonce, expiresAt };
}

interface ConfirmationGateInput {
  record: PendingConfirmationRecord;
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  now: Date;
  expectedActionFingerprint?: string;
  expectedCatalogHash?: string;
}

/**
 * The four shared confirmation guards in order — tenant binding, status,
 * fail-closed expiry, op-hash tripwire — single-sourced for {@link confirmPending}
 * and {@link rotatePendingNonce}. Returns the first failure or `{ ok: true }`.
 * The nonce check stays OUT of this gate: confirmPending validates the nonce
 * after it, rotatePendingNonce mints a fresh one.
 */
function checkConfirmationGate(
  g: ConfirmationGateInput,
): { ok: true } | { ok: false; code: string; message: string } {
  const { record, now } = g;

  // Binding BEFORE status (matches cancelPending): a non-owner must always get
  // "forbidden", never the preview's lifecycle state — the route fetches the
  // record by id with no scoping, so this gate is the only tenant boundary.
  if (
    record.sessionId !== g.sessionId ||
    record.workspaceId !== g.workspaceId ||
    record.adminUserId !== g.adminUserId
  ) {
    return { ok: false, code: "forbidden", message: "This preview belongs to a different session." };
  }
  // Store reads lazily terminalize a due preview together with its prepared
  // operation. Preserve the precise public expiry response after that atomic
  // transition instead of degrading it to the generic already-used message.
  if (record.status === "expired") {
    return { ok: false, code: "expired", message: "This preview has expired. Ask me to run a fresh preview." };
  }
  if (record.status !== "pending") {
    return { ok: false, code: "not_pending", message: "This preview is no longer pending." };
  }
  const expiresAtMs = new Date(record.expiresAt).getTime();
  if (Number.isNaN(expiresAtMs) || now.getTime() >= expiresAtMs) {
    // Fail CLOSED on an unparseable expiry — `now >= NaN` is false, which would
    // otherwise leave a corrupt/tampered TTL confirmable forever.
    return { ok: false, code: "expired", message: "This preview has expired. Ask me to run a fresh preview." };
  }
  // Tamper tripwire: the stored operation must still hash to the stored hash
  // (SAFETY_AND_PERMISSIONS "operation hash matches stored operation").
  if (!timingSafeStringEqual(confirmationOperationBindingHash(record), record.operationHash)) {
    return { ok: false, code: "operation_mismatch", message: "Preview integrity check failed." };
  }
  if (g.expectedActionFingerprint) {
    if (!timingSafeStringEqual(record.actionFingerprint, g.expectedActionFingerprint)) {
      return { ok: false, code: "incompatible_confirmation", message: "This preview was created by incompatible action code. Run a fresh preview." };
    }
  }
  if (g.expectedCatalogHash && !timingSafeStringEqual(record.catalogHash, g.expectedCatalogHash)) {
    return { ok: false, code: "incompatible_confirmation", message: "The action catalog changed after this preview. Run a fresh preview." };
  }
  return { ok: true };
}

export function confirmPending(input: ConfirmPendingInput): ConfirmPendingResult {
  const { record } = input;
  const now = input.now ?? new Date();

  const gate = checkConfirmationGate({
    record,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    adminUserId: input.adminUserId,
    now,
    ...(input.expectedActionFingerprint ? { expectedActionFingerprint: input.expectedActionFingerprint } : {}),
    ...(input.expectedCatalogHash ? { expectedCatalogHash: input.expectedCatalogHash } : {}),
  });
  if (!gate.ok) return gate;

  if (
    !timingSafeStringEqual(
      hashNonce(input.nonce, record.id, record.operationHash, input.sessionSecret),
      record.nonceHash,
    )
  ) {
    return { ok: false, code: "invalid_confirmation", message: "Confirmation does not match this preview." };
  }

  return {
    ok: true,
    record: { ...record, status: "executing", usedAt: now.toISOString() },
  };
}

export interface RotateNonceInput {
  record: PendingConfirmationRecord;
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  sessionSecret: string;
  now?: Date;
  /** Injectable for deterministic tests. */
  nonce?: string;
}

export type RotateNonceResult =
  | { ok: true; record: PendingConfirmationRecord; nonce: string }
  | { ok: false; code: string; message: string };

/**
 * Re-issue the one-use nonce for a still-live pending preview (session restore:
 * the plaintext nonce lives only in the UI, so an iframe reload strands the
 * card). Rotation preserves the one-use property exactly — at any instant ONE
 * plaintext validates, and storing the new hash kills the old one — and is
 * gated by the same session/workspace/admin binding as confirm, so no privilege
 * is gained. `expiresAt` is NEVER extended. Validation mirrors
 * {@link confirmPending}'s gate order (minus the nonce check — we're minting it).
 */
export function rotatePendingNonce(input: RotateNonceInput): RotateNonceResult {
  const { record } = input;
  const now = input.now ?? new Date();

  const gate = checkConfirmationGate({
    record,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    adminUserId: input.adminUserId,
    now,
  });
  if (!gate.ok) return gate;

  const nonce = input.nonce ?? randomBytes(32).toString("base64url");
  return {
    ok: true,
    nonce,
    record: { ...record, nonceHash: hashNonce(nonce, record.id, record.operationHash, input.sessionSecret) },
  };
}

const TRUSTED_DIRECT_ORIGINS = new Set<ActionOrigin>(["direct_ui", "system", "live_test"]);
const V2_PREVIEW_EXECUTORS = new Set<ExecutorKind>(["prepared_safe_write", "risky_commit"]);

/** Shared v2 assistant preview authority — identical for single and batch-owned rows. */
function isV2PreviewAuthority(record: PendingConfirmationRecord): boolean {
  return record.origin === "assistant" &&
    record.registryId === "v2-api" &&
    record.authorityModel === "preview_confirmation_v2" &&
    !!record.executorKind &&
    V2_PREVIEW_EXECUTORS.has(record.executorKind) &&
    typeof record.runId === "string" &&
    record.runId.length > 0 &&
    !record.capabilityId;
}

/** True when this pending row is a v2 assistant preview awaiting single confirm. */
export function isV2AssistantPreviewConfirmation(record: PendingConfirmationRecord): boolean {
  return isV2PreviewAuthority(record) && !record.batchId;
}

/** Hash bound to nonce validation and the persisted operation_run payload for v2 previews.
 * Batch ownership must not change the binding hash — rows are hashed before batch_id is set. */
export function confirmationOperationBindingHash(record: PendingConfirmationRecord): string {
  if (isV2PreviewAuthority(record)) {
    const operation = record.operation;
    if (operation && typeof operation === "object" && !Array.isArray(operation)) {
      const payload = (operation as { payload?: unknown }).payload;
      return hashOperation(exactNonsecretJson(JSON.parse(JSON.stringify(payload ?? {}))));
    }
  }
  return hashOperation(record.operation);
}

/** Batch-owned previews must use the batch confirm route (Task 11-E). */
export function isBatchOwnedConfirmation(record: PendingConfirmationRecord): boolean {
  return typeof record.batchId === "string" && record.batchId.length > 0;
}

/** True when this pending row is a v2 assistant batch preview awaiting batch confirm. */
export function isV2AssistantBatchConfirmation(record: PendingConfirmationRecord): boolean {
  return isV2PreviewAuthority(record) && isBatchOwnedConfirmation(record);
}

export function isTrustedDirectOrigin(origin: ActionOrigin | undefined): origin is ActionOrigin {
  return !!origin && TRUSTED_DIRECT_ORIGINS.has(origin);
}

export function cancelPending(input: CancelPendingInput): CancelPendingResult {
  const { record } = input;
  const now = input.now ?? new Date();

  if (
    record.sessionId !== input.sessionId ||
    record.workspaceId !== input.workspaceId ||
    record.adminUserId !== input.adminUserId
  ) {
    return { ok: false, code: "forbidden", message: "This preview belongs to a different session." };
  }
  if (record.status !== "pending") {
    return { ok: false, code: "not_pending", message: "This preview is no longer pending." };
  }

  return {
    ok: true,
    record: { ...record, status: "cancelled", usedAt: now.toISOString() },
  };
}
