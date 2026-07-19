import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import type { ReleaseSourceRelationship } from "../release-artifact.js";

const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const HMAC_DOMAIN = "ai-assistant:fresh-install-attestation:v1";

export type AttestedSourceRelationship = Exclude<ReleaseSourceRelationship, "unbound">;

export interface InstallationAttestationBinding {
  releaseSha: string;
  releaseBuildHash: string;
  serverArtifactSha256: string;
  sourceRelationship: AttestedSourceRelationship;
  sourceBindingSha256: string | null;
  manifestSha256: string;
}

export interface InstallationAttestationRecord extends InstallationAttestationBinding {
  workspaceSha256: string;
  installationGeneration: number;
  installedAt: string;
}

export interface InstallationAttestationEnvelope {
  schemaVersion: 1;
  algorithm: "HMAC-SHA256";
  payload: InstallationAttestationRecord;
  signature: string;
}

export type InstallationAttestationVerification =
  | { valid: false }
  | ({ valid: true; attestationSha256: string } & InstallationAttestationRecord);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  throw new Error("installation_attestation_canonical_json_invalid");
}

export function hashCanonicalAttestationJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function hashInstallationToken(token: string): string {
  return createHash("sha256")
    .update("ai-assistant:installation-token:v1\n")
    .update(token)
    .digest("hex");
}

/** One-way anti-replay fingerprint retained after uninstall. Its separate
 * domain prevents linking the retired-token ledger to the active attestation
 * fingerprint, even when both databases/backups are inspected together. */
export function hashRetiredInstallationToken(token: string): string {
  return createHash("sha256")
    .update("ai-assistant:retired-installation-token:v1\n")
    .update(token)
    .digest("hex");
}

export function hashInstallationWorkspace(workspaceId: string): string {
  return createHash("sha256")
    .update("ai-assistant:installation-workspace:v1\n")
    .update(workspaceId)
    .digest("hex");
}

export function deriveInstallationAttestationKey(sessionSecret: string): Buffer {
  return createHmac("sha256", sessionSecret).update(HMAC_DOMAIN).digest();
}

function unsignedEnvelope(payload: InstallationAttestationRecord): Omit<InstallationAttestationEnvelope, "signature"> {
  return { schemaVersion: 1, algorithm: "HMAC-SHA256", payload };
}

function sign(payload: InstallationAttestationRecord, key: Buffer): Buffer {
  return createHmac("sha256", key)
    .update(HMAC_DOMAIN)
    .update("\n")
    .update(canonicalJson(unsignedEnvelope(payload)))
    .digest();
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function parseRecord(value: unknown): InstallationAttestationRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, [
    "installationGeneration",
    "installedAt",
    "manifestSha256",
    "releaseBuildHash",
    "releaseSha",
    "serverArtifactSha256",
    "sourceBindingSha256",
    "sourceRelationship",
    "workspaceSha256",
  ])) return undefined;
  if (
    typeof record.workspaceSha256 !== "string" || !SHA256_PATTERN.test(record.workspaceSha256)
    || typeof record.installationGeneration !== "number"
    || !Number.isSafeInteger(record.installationGeneration)
    || record.installationGeneration < 1
    || typeof record.releaseSha !== "string" || !SHA_PATTERN.test(record.releaseSha)
    || typeof record.releaseBuildHash !== "string" || !SHA256_PATTERN.test(record.releaseBuildHash)
    || typeof record.serverArtifactSha256 !== "string" || !SHA256_PATTERN.test(record.serverArtifactSha256)
    || !["exact_head", "evidence_descendant", "source_bound_builder"].includes(String(record.sourceRelationship))
    || typeof record.manifestSha256 !== "string" || !SHA256_PATTERN.test(record.manifestSha256)
    || typeof record.installedAt !== "string" || !ISO_PATTERN.test(record.installedAt)
    || new Date(record.installedAt).toISOString() !== record.installedAt
  ) return undefined;
  if (record.sourceRelationship === "source_bound_builder") {
    if (typeof record.sourceBindingSha256 !== "string" || !SHA256_PATTERN.test(record.sourceBindingSha256)) {
      return undefined;
    }
  } else if (record.sourceBindingSha256 !== null) {
    return undefined;
  }
  return record as unknown as InstallationAttestationRecord;
}

export function createInstallationAttestationEnvelope(
  record: InstallationAttestationRecord,
  key: Buffer,
): InstallationAttestationEnvelope {
  const parsed = parseRecord(record);
  if (!parsed) throw new Error("installation_attestation_record_invalid");
  return {
    ...unsignedEnvelope(parsed),
    signature: sign(parsed, key).toString("base64url"),
  };
}

export function verifyInstallationAttestationEnvelope(
  value: unknown,
  key: Buffer,
): InstallationAttestationVerification {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false };
  const envelope = value as Record<string, unknown>;
  if (!exactKeys(envelope, ["algorithm", "payload", "schemaVersion", "signature"])) {
    return { valid: false };
  }
  if (
    envelope.schemaVersion !== 1
    || envelope.algorithm !== "HMAC-SHA256"
    || typeof envelope.signature !== "string"
  ) return { valid: false };
  const payload = parseRecord(envelope.payload);
  if (!payload) return { valid: false };
  let supplied: Buffer;
  try {
    supplied = Buffer.from(envelope.signature, "base64url");
  } catch {
    return { valid: false };
  }
  const expected = sign(payload, key);
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    return { valid: false };
  }
  return {
    valid: true,
    attestationSha256: hashCanonicalAttestationJson(payload),
    ...payload,
  };
}
