import { createHash } from "node:crypto";
import { exactNonsecretJson, jsonByteLength } from "./safe-json.js";
import {
  INTENT_LITERAL_CONSTRAINT_LIMIT,
  INTENT_LITERAL_MAX_BYTES,
  INTENT_LITERAL_MAX_DEPTH,
  INTENT_LITERAL_MAX_NODES,
} from "./safety-limits.js";

export {
  INTENT_LITERAL_CONSTRAINT_LIMIT,
  INTENT_LITERAL_MAX_BYTES,
  INTENT_LITERAL_MAX_DEPTH,
  INTENT_LITERAL_MAX_NODES,
} from "./safety-limits.js";

const CAPABILITY_MAX_BYTES = 65_536;
const SENSITIVE_PATH = /authorization|cookie|header|secret|token|password|api[_-]?key|bytes|binary/i;

export interface Utf8SourceSpan {
  /** Inclusive UTF-8 byte offset into the exact canonical authored-source string. */
  startByte: number;
  /** Exclusive UTF-8 byte offset into the exact canonical authored-source string. */
  endByte: number;
  /** Exact decoded text in [startByte, endByte). */
  text: string;
}

export type IntentLiteralValue =
  | string
  | number
  | boolean
  | null
  | IntentLiteralValue[]
  | { [key: string]: IntentLiteralValue };

export interface IntentLiteralConstraintV1 {
  /** Raw model-argument path controlled by the authored literal. */
  path: string;
  value: IntentLiteralValue;
  sourceSpan: Utf8SourceSpan;
}

export interface IntentWriteActionV1 {
  actionName: string;
  sourceSpans: Utf8SourceSpan[];
  literalConstraints: IntentLiteralConstraintV1[];
  maxExecutions: number;
}

interface IntentCapabilityBaseV1 {
  version: 1;
  requestHash: string;
  catalogHash: string;
  writeActions: IntentWriteActionV1[];
}

export interface AllowIntentCapabilityV1 extends IntentCapabilityBaseV1 {
  mode: "allow";
}

export interface DenyAllWritesIntentCapabilityV1 extends IntentCapabilityBaseV1 {
  mode: "deny_all_writes";
  reason: string;
  writeActions: [];
}

export type IntentCapabilityV1 = AllowIntentCapabilityV1 | DenyAllWritesIntentCapabilityV1;

export class IntentCapabilityValidationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "IntentCapabilityValidationError";
  }
}

export interface IntentWriteActionDraftV1 {
  actionName: string;
  sourceSpans: Utf8SourceSpan[];
  literalConstraints: IntentLiteralConstraintV1[];
  maxExecutions?: number;
}

function fail(code: string): never {
  throw new IntentCapabilityValidationError(code);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function copyLiteralNode(value: unknown, depth: number, state: { nodes: number }, seen: WeakSet<object>): IntentLiteralValue {
  state.nodes += 1;
  if (state.nodes > INTENT_LITERAL_MAX_NODES) fail("intent_capability_literal_nodes_exceeded");
  if (depth > INTENT_LITERAL_MAX_DEPTH) fail("intent_capability_literal_depth_exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("intent_capability_literal_non_json");
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= INTENT_LITERAL_MAX_DEPTH) fail("intent_capability_literal_depth_exceeded");
    if (seen.has(value)) fail("intent_capability_literal_non_json");
    seen.add(value);
    const result = value.map((child) => copyLiteralNode(child, depth + 1, state, seen));
    seen.delete(value);
    return result;
  }
  if (value && typeof value === "object") {
    if (depth >= INTENT_LITERAL_MAX_DEPTH) fail("intent_capability_literal_depth_exceeded");
    if (seen.has(value)) fail("intent_capability_literal_non_json");
    seen.add(value);
    // A null-prototype intermediate prevents an authored `__proto__` key from
    // invoking Object.prototype's legacy setter and disappearing from the
    // signed capability value.
    const result = Object.create(null) as Record<string, IntentLiteralValue>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = copyLiteralNode((value as Record<string, unknown>)[key], depth + 1, state, seen);
    }
    seen.delete(value);
    return result;
  }
  return fail("intent_capability_literal_non_json");
}

export function parseIntentLiteralValue(value: unknown): IntentLiteralValue {
  const literal = copyLiteralNode(value, 1, { nodes: 0 }, new WeakSet());
  if (jsonByteLength(literal) > INTENT_LITERAL_MAX_BYTES) fail("intent_capability_literal_bytes_exceeded");
  return literal;
}

function parseSpan(value: unknown): Utf8SourceSpan {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("intent_capability_span_invalid");
  const span = value as Partial<Utf8SourceSpan>;
  if (!Number.isSafeInteger(span.startByte) || !Number.isSafeInteger(span.endByte) ||
    (span.startByte as number) < 0 || (span.endByte as number) <= (span.startByte as number) ||
    typeof span.text !== "string" || span.text.length === 0) {
    fail("intent_capability_span_invalid");
  }
  return { startByte: span.startByte as number, endByte: span.endByte as number, text: span.text };
}

/**
 * Validate and decode one source span using UTF-8 byte offsets. A fatal decoder
 * makes an offset inside a multibyte code point fail closed; callers in the
 * declaration and raw-argument matching paths must share this implementation.
 */
export function validateUtf8SourceSpan(authoredSource: string, value: Utf8SourceSpan): string {
  const span = parseSpan(value);
  const bytes = Buffer.from(authoredSource, "utf8");
  if (span.endByte > bytes.length) fail("intent_capability_span_range");
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(span.startByte, span.endByte));
  } catch {
    return fail("intent_capability_span_boundary");
  }
  if (Buffer.byteLength(decoded, "utf8") !== span.endByte - span.startByte) {
    fail("intent_capability_span_boundary");
  }
  if (decoded !== span.text) fail("intent_capability_span_text_mismatch");
  return decoded;
}

export function hashIntentRequest(authoredSource: string): string {
  return createHash("sha256").update(authoredSource, "utf8").digest("hex");
}

export function hashIntentCapability(capability: IntentCapabilityV1): string {
  return createHash("sha256").update(JSON.stringify(stableValue(capability)), "utf8").digest("hex");
}

function parseWriteAction(value: unknown, authoredSource?: string): IntentWriteActionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("intent_capability_action_invalid");
  const action = value as {
    actionName?: unknown;
    sourceSpans?: unknown;
    literalConstraints?: unknown;
    maxExecutions?: unknown;
  };
  if (typeof action.actionName !== "string" || !/^[a-z][a-z0-9_]{0,127}$/.test(action.actionName)) {
    fail("intent_capability_action_invalid");
  }
  if (!Array.isArray(action.sourceSpans) || action.sourceSpans.length === 0 || action.sourceSpans.length > 128) {
    fail("intent_capability_spans_invalid");
  }
  const sourceSpans = action.sourceSpans.map(parseSpan);
  for (const span of sourceSpans) if (authoredSource !== undefined) validateUtf8SourceSpan(authoredSource, span);
  if (!Array.isArray(action.literalConstraints) || action.literalConstraints.length > INTENT_LITERAL_CONSTRAINT_LIMIT) {
    fail("intent_capability_constraints_invalid");
  }
  const paths = new Set<string>();
  const literalConstraints = action.literalConstraints.map((raw): IntentLiteralConstraintV1 => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("intent_capability_constraint_invalid");
    const constraint = raw as { path?: unknown; value?: unknown; sourceSpan?: unknown };
    if (typeof constraint.path !== "string" || constraint.path.length === 0 || constraint.path.length > 256) {
      fail("intent_capability_constraint_invalid");
    }
    if (SENSITIVE_PATH.test(constraint.path)) fail("intent_capability_sensitive_path");
    if (paths.has(constraint.path)) fail("intent_capability_constraint_duplicate");
    paths.add(constraint.path);
    const sourceSpan = parseSpan(constraint.sourceSpan);
    if (authoredSource !== undefined) validateUtf8SourceSpan(authoredSource, sourceSpan);
    if (!sourceSpans.some((span) => span.startByte === sourceSpan.startByte &&
      span.endByte === sourceSpan.endByte && span.text === sourceSpan.text)) {
      fail("intent_capability_constraint_span_unbound");
    }
    return { path: constraint.path, value: parseIntentLiteralValue(constraint.value), sourceSpan };
  });
  const maxExecutions = action.maxExecutions === undefined ? 1 : action.maxExecutions;
  if (typeof maxExecutions !== "number" || !Number.isSafeInteger(maxExecutions) ||
    maxExecutions < 1 || maxExecutions > 1_000) {
    fail("intent_capability_execution_limit_invalid");
  }
  return { actionName: action.actionName, sourceSpans, literalConstraints, maxExecutions };
}

/** Parse a persisted capability. Supplying authoredSource additionally proves
 * its request hash and every byte span against the exact original text. */
export function parseIntentCapabilityV1(value: unknown, authoredSource?: string): IntentCapabilityV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("intent_capability_invalid");
  const candidate = value as {
    version?: unknown;
    mode?: unknown;
    requestHash?: unknown;
    catalogHash?: unknown;
    reason?: unknown;
    writeActions?: unknown;
  };
  if (candidate.version !== 1 || (candidate.mode !== "allow" && candidate.mode !== "deny_all_writes") ||
    typeof candidate.requestHash !== "string" || candidate.requestHash.length !== 64 ||
    typeof candidate.catalogHash !== "string" || candidate.catalogHash.length === 0 || candidate.catalogHash.length > 256 ||
    !Array.isArray(candidate.writeActions)) {
    fail("intent_capability_invalid");
  }
  if (authoredSource !== undefined && hashIntentRequest(authoredSource) !== candidate.requestHash) {
    fail("intent_capability_request_hash_mismatch");
  }
  if (candidate.mode === "deny_all_writes") {
    if (typeof candidate.reason !== "string" || candidate.reason.length === 0 || candidate.reason.length > 256 ||
      candidate.writeActions.length !== 0) {
      fail("intent_capability_deny_invalid");
    }
    const denied = exactNonsecretJson({
      version: 1,
      mode: "deny_all_writes",
      requestHash: candidate.requestHash,
      catalogHash: candidate.catalogHash,
      reason: candidate.reason,
      writeActions: [],
    }, CAPABILITY_MAX_BYTES) as DenyAllWritesIntentCapabilityV1;
    return deepFreeze(denied);
  }
  if (candidate.writeActions.length === 0 || candidate.writeActions.length > 128) {
    fail("intent_capability_actions_invalid");
  }
  const actionNames = new Set<string>();
  const writeActions = candidate.writeActions.map((action) => {
    const parsed = parseWriteAction(action, authoredSource);
    if (actionNames.has(parsed.actionName)) fail("intent_capability_action_duplicate");
    actionNames.add(parsed.actionName);
    return parsed;
  });
  const allowed = exactNonsecretJson({
    version: 1,
    mode: "allow",
    requestHash: candidate.requestHash,
    catalogHash: candidate.catalogHash,
    writeActions,
  }, CAPABILITY_MAX_BYTES) as AllowIntentCapabilityV1;
  return deepFreeze(allowed);
}

export function buildAllowIntentCapabilityV1(input: {
  authoredSource: string;
  catalogHash: string;
  writeActions: IntentWriteActionDraftV1[];
}): AllowIntentCapabilityV1 {
  return parseIntentCapabilityV1({
    version: 1,
    mode: "allow",
    requestHash: hashIntentRequest(input.authoredSource),
    catalogHash: input.catalogHash,
    writeActions: input.writeActions,
  }, input.authoredSource) as AllowIntentCapabilityV1;
}

export function buildDenyAllWritesIntentCapabilityV1(input: {
  authoredSource: string;
  catalogHash: string;
  reason: string;
}): DenyAllWritesIntentCapabilityV1 {
  return parseIntentCapabilityV1({
    version: 1,
    mode: "deny_all_writes",
    requestHash: hashIntentRequest(input.authoredSource),
    catalogHash: input.catalogHash,
    reason: input.reason,
    writeActions: [],
  }, input.authoredSource) as DenyAllWritesIntentCapabilityV1;
}
