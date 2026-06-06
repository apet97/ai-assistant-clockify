/**
 * Uniform receipt shapes (SPEC "Receipt Shape" / "Error Behavior").
 *
 * Every mutation returns a SuccessReceipt with a `changed` set, or an
 * ErrorReceipt carrying a stable code plus a recovery hint. Empty change buckets
 * and empty optional fields are omitted so a clean read does not look like a
 * write.
 */

export interface EntityRef {
  type: string;
  id: string;
  name?: string;
}

export interface ChangeSet {
  created?: EntityRef[];
  updated?: EntityRef[];
  deleted?: EntityRef[];
  reused?: EntityRef[];
}

export interface Warning {
  code?: string;
  message: string;
}

export interface NextAction {
  action: string;
  args?: Record<string, unknown>;
  reason?: string;
}

export interface RecoveryHint {
  hint: string;
  retryable?: boolean;
  action?: string;
  args?: Record<string, unknown>;
}

export interface SuccessReceipt {
  ok: true;
  action: string;
  entity?: string;
  ids?: Record<string, string>;
  /** Read payload (e.g. status, lists). Mutations use `changed` instead. */
  data?: unknown;
  changed?: ChangeSet;
  warnings?: Warning[];
  next?: NextAction[];
}

export interface ErrorReceipt {
  ok: false;
  action: string;
  code: string;
  message: string;
  recovery: RecoveryHint;
}

export interface SuccessReceiptInput {
  action: string;
  entity?: string;
  ids?: Record<string, string | undefined>;
  data?: unknown;
  changed?: ChangeSet;
  warnings?: Warning[];
  next?: NextAction[];
}

export interface ErrorReceiptInput {
  action: string;
  code: string;
  message: string;
  recovery?: RecoveryHint;
}

const CHANGE_BUCKETS: Array<keyof ChangeSet> = ["created", "updated", "deleted", "reused"];

export function hasChanges(changed: ChangeSet | undefined): boolean {
  if (!changed) return false;
  return CHANGE_BUCKETS.some((bucket) => {
    const refs = changed[bucket];
    return Array.isArray(refs) && refs.length > 0;
  });
}

function cleanChangeSet(changed: ChangeSet | undefined): ChangeSet | undefined {
  if (!hasChanges(changed)) return undefined;
  const out: ChangeSet = {};
  for (const bucket of CHANGE_BUCKETS) {
    const refs = changed?.[bucket];
    if (Array.isArray(refs) && refs.length > 0) out[bucket] = refs;
  }
  return out;
}

function cleanIds(
  ids: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined {
  if (!ids) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(ids)) {
    if (value && value.trim()) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function successReceipt(input: SuccessReceiptInput): SuccessReceipt {
  const receipt: SuccessReceipt = { ok: true, action: input.action };
  if (input.entity) receipt.entity = input.entity;
  if (input.data !== undefined) receipt.data = input.data;
  const ids = cleanIds(input.ids);
  if (ids) receipt.ids = ids;
  const changed = cleanChangeSet(input.changed);
  if (changed) receipt.changed = changed;
  if (input.warnings && input.warnings.length > 0) receipt.warnings = input.warnings;
  if (input.next && input.next.length > 0) receipt.next = input.next;
  return receipt;
}

export function errorReceipt(input: ErrorReceiptInput): ErrorReceipt {
  return {
    ok: false,
    action: input.action,
    code: input.code,
    message: input.message,
    recovery: input.recovery ?? { hint: input.message, retryable: false },
  };
}
