import { createHash } from "node:crypto";

const SENSITIVE_KEY = /(?:authorization|cookie|header|secret|token|password|api[_-]?key|bytes|binary)/i;
const MAX_STRING = 4_096;
const MAX_ARRAY = 128;
const MAX_DEPTH = 12;

function normalized(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length <= MAX_STRING ? value : `${value.slice(0, MAX_STRING - 1)}…`;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return undefined;
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return { truncated: true, reason: "max_depth" };
    const rows = value.slice(0, MAX_ARRAY).flatMap((item) => {
      const next = normalized(item, depth + 1);
      return next === undefined ? [] : [next];
    });
    if (value.length > MAX_ARRAY) rows.push({ truncated: true, originalItemCount: value.length });
    return rows;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "Buffer" && Array.isArray(record.data)) return undefined;
    const keys = Object.keys(record);
    if (keys.length > 0 && keys.every((key) => /^\d+$/.test(key)) &&
      keys.every((key) => Number.isInteger(record[key]) && (record[key] as number) >= 0 && (record[key] as number) <= 255)) {
      return undefined;
    }
    if (depth >= MAX_DEPTH) return { truncated: true, reason: "max_depth" };
    const result: Record<string, unknown> = {};
    for (const key of keys.sort()) {
      if (SENSITIVE_KEY.test(key)) continue;
      const child = normalized(record[key], depth + 1);
      if (child !== undefined) result[key] = child;
    }
    return result;
  }
  return undefined;
}

function completeNormalized(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return undefined;
  if (Array.isArray(value)) {
    if (seen.has(value)) return { invalid: true, reason: "cycle" };
    seen.add(value);
    const rows = value.flatMap((item) => {
      const next = completeNormalized(item, seen);
      return next === undefined ? [] : [next];
    });
    seen.delete(value);
    return rows;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "Buffer" && Array.isArray(record.data)) return undefined;
    const keys = Object.keys(record);
    if (keys.length > 0 && keys.every((key) => /^\d+$/.test(key)) &&
      keys.every((key) => Number.isInteger(record[key]) && (record[key] as number) >= 0 && (record[key] as number) <= 255)) {
      return undefined;
    }
    if (seen.has(value)) return { invalid: true, reason: "cycle" };
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of keys.sort()) {
      if (SENSITIVE_KEY.test(key)) continue;
      const child = completeNormalized(record[key], seen);
      if (child !== undefined) result[key] = child;
    }
    seen.delete(value);
    return result;
  }
  return undefined;
}

export function sanitizeJson(value: unknown): unknown {
  return normalized(value, 0) ?? null;
}

/** Redacts secrets/binary data without truncating evidence used for equality or matching. */
export function sanitizeCompleteJson(value: unknown): unknown {
  return completeNormalized(value, new WeakSet()) ?? null;
}

function exactNonsecret(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("durable_evidence_non_json");
    return value;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) throw new Error("durable_evidence_binary");
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("durable_evidence_cycle");
    seen.add(value);
    const rows = value.map((item) => exactNonsecret(item, seen));
    seen.delete(value);
    return rows;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "Buffer" && Array.isArray(record.data)) throw new Error("durable_evidence_binary");
    if (seen.has(value)) throw new Error("durable_evidence_cycle");
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (SENSITIVE_KEY.test(key)) throw new Error("durable_evidence_sensitive");
      result[key] = exactNonsecret(record[key], seen);
    }
    seen.delete(value);
    return result;
  }
  throw new Error("durable_evidence_non_json");
}

/** Lossless pre-dispatch evidence boundary. Unlike presentation sanitization it
 * never truncates IDs/arrays; unsafe or oversized evidence fails before I/O. */
export function exactNonsecretJson(value: unknown, maxBytes = 65_536): unknown {
  const safe = exactNonsecret(value, new WeakSet());
  if (jsonByteLength(safe) > maxBytes) throw new Error("durable_evidence_too_large");
  return safe;
}

export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundedPreview(value: string, originalByteCount: number, maxBytes: number): unknown {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { truncated: true, originalByteCount, preview: value.slice(0, middle) };
    if (jsonByteLength(candidate) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const result = { truncated: true, originalByteCount, preview: value.slice(0, low) };
  if (jsonByteLength(result) <= maxBytes) return result;
  const minimal = { truncated: true };
  return jsonByteLength(minimal) <= maxBytes ? minimal : null;
}

export function boundedSanitizedJson(value: unknown, maxBytes = 65_536): unknown {
  const safe = sanitizeJson(value);
  if (jsonByteLength(safe) <= maxBytes) return safe;
  const encoded = JSON.stringify(safe);
  return boundedPreview(encoded, Buffer.byteLength(encoded, "utf8"), maxBytes);
}

/** Complete-key/value redaction for stored operational detail. Ordinary arrays
 * and strings remain lossless whenever the redacted JSON fits the byte cap. */
export function boundedCompleteSanitizedJson(value: unknown, maxBytes = 65_536): unknown {
  const safe = sanitizeCompleteJson(value);
  if (jsonByteLength(safe) <= maxBytes) return safe;
  const encoded = JSON.stringify(safe);
  return boundedPreview(encoded, Buffer.byteLength(encoded, "utf8"), maxBytes);
}

export function sanitizedFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sanitizeCompleteJson(value))).digest("hex");
}
