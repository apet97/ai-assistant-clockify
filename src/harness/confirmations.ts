import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { RiskLabel } from "./risk.js";

/**
 * One-use risky-write confirmation lifecycle (SPEC "Confirmation Rules",
 * SAFETY_AND_PERMISSIONS "Confirmation Token"). These are pure functions over a
 * record shaped like the `pending_confirmations` row; the store persists them.
 *
 * The exact operation payload to execute is stored server-side and never
 * reconstructed from chat text. Confirmation is button-only: the page sends back
 * an opaque nonce whose hash must match the stored hash.
 */

export const DEFAULT_TTL_MS = 5 * 60 * 1000;

export type PendingStatus =
  | "pending"
  | "executing"
  | "used"
  | "cancelled"
  | "expired"
  | "failed";

export interface PendingConfirmationRecord {
  id: string;
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  status: PendingStatus;
  risk: RiskLabel[];
  preview: unknown;
  operation: unknown;
  operationHash: string;
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
}

export interface CreateConfirmationInput {
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  risk: RiskLabel[];
  preview: unknown;
  operation: unknown;
  sessionSecret: string;
  now?: Date;
  ttlMs?: number;
  /** Injectable for deterministic tests. */
  id?: string;
  nonce?: string;
  /** Suspended agentic-turn state to persist with the preview (Phase 3). */
  agentState?: unknown;
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
  const operationHash = hashOperation(input.operation);

  const record: PendingConfirmationRecord = {
    id,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    adminUserId: input.adminUserId,
    status: "pending",
    risk: input.risk,
    preview: input.preview,
    operation: input.operation,
    operationHash,
    nonceHash: hashNonce(nonce, id, operationHash, input.sessionSecret),
    expiresAt,
    createdAt: now.toISOString(),
    agentState: input.agentState,
  };

  return { record, previewId: id, nonce, expiresAt };
}

export function confirmPending(input: ConfirmPendingInput): ConfirmPendingResult {
  const { record } = input;
  const now = input.now ?? new Date();

  if (record.status !== "pending") {
    return { ok: false, code: "not_pending", message: "This preview is no longer pending." };
  }
  if (
    record.sessionId !== input.sessionId ||
    record.workspaceId !== input.workspaceId ||
    record.adminUserId !== input.adminUserId
  ) {
    return { ok: false, code: "forbidden", message: "This preview belongs to a different session." };
  }
  if (now.getTime() >= new Date(record.expiresAt).getTime()) {
    return { ok: false, code: "expired", message: "This preview has expired. Ask me to run a fresh preview." };
  }
  // Tamper tripwire: the stored operation must still hash to the stored hash
  // (SAFETY_AND_PERMISSIONS "operation hash matches stored operation").
  if (!timingSafeStringEqual(hashOperation(record.operation), record.operationHash)) {
    return { ok: false, code: "operation_mismatch", message: "Preview integrity check failed." };
  }
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
    record: { ...record, status: "used", usedAt: now.toISOString() },
  };
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
