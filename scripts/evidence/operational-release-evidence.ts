import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CLOCKIFY_SCOPE_ENFORCEMENT_SHA256,
  CLOCKIFY_SCOPE_ENFORCEMENT_SOURCE,
  REQUIRED_SCOPES,
} from "../../src/addon/scope-contract.js";
import {
  MIN_SUPPORTED_RESTORE_SOURCE_SCHEMA_VERSION,
  RESTORE_REQUIRED_COLUMN_COUNT,
  RESTORE_REQUIRED_TABLE_COUNT,
} from "../../src/db/restore-verification.js";
import { LATEST_SCHEMA_VERSION } from "../../src/db/schema.js";
import { hashCanonicalJson } from "../lib/live-evidence.js";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_EVIDENCE_BYTES = 1_048_576;
const ALLOWED_EVIDENCE_DESCENDANT_PATHS = [
  "docs/marketplace/evidence/",
  "evidence/operations/",
  "evidence/performance/",
] as const;

type JsonObject = Record<string, unknown>;

export interface OperationalReleaseEvidenceInput {
  sourceCandidateSha: string;
  evidenceCommitSha: string;
  deployedVersion: JsonObject;
  deployedManifest: unknown;
  attestationVerification: JsonObject;
  restoreEvidence: unknown;
  scopeEvidence: unknown;
  requiredScopes?: readonly string[];
}

export interface OperationalReleaseEvidence {
  schemaVersion: 1;
  conclusion: "passed";
  sourceCandidateSha: string;
  evidenceCommitSha: string;
  deployed: {
    releaseBuildHash: string;
    serverArtifactSha256: string;
    sourceRelationship: "exact_head" | "evidence_descendant" | "source_bound_builder";
    sourceBindingSha256: string | null;
    manifestSha256: string;
  };
  backupRestore: {
    evidenceSha256: string;
    rtoMs: number;
    rpoMs: number;
  };
  scopeAndAudit: {
    evidenceSha256: string;
    attestationSha256: string;
    retainedScopeCount: number;
    auditHost: "AUTH_OK";
  };
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value as JsonObject;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is malformed`);
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  const candidate = string(value, label);
  if (!SHA256_PATTERN.test(candidate)) throw new Error(`${label} is malformed`);
  return candidate;
}

function fullCommit(value: unknown, label: string): string {
  const candidate = string(value, label);
  if (!SHA_PATTERN.test(candidate)) throw new Error(`${label} is malformed`);
  return candidate;
}

function iso(value: unknown, label: string): string {
  const candidate = string(value, label);
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== candidate) {
    throw new Error(`${label} is malformed`);
  }
  return candidate;
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} mismatch`);
}

function assertSecretFree(value: unknown): void {
  const forbiddenKeys = /^(?:addon_?token|api_?key|authorization|cookie|headers?|raw_?response|workspace_?id|immutable_?reference)$/iu;
  const visit = (child: unknown): void => {
    if (typeof child === "string") {
      if (/\bBearer\s+[A-Za-z0-9._~+/-]+=*/iu.test(child) || /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u.test(child)) {
        throw new Error("operational evidence is not secret-free");
      }
      return;
    }
    if (Array.isArray(child)) {
      for (const item of child) visit(item);
      return;
    }
    if (child && typeof child === "object") {
      for (const [key, nested] of Object.entries(child as JsonObject)) {
        if (forbiddenKeys.test(key)) throw new Error("operational evidence is not secret-free");
        visit(nested);
      }
    }
  };
  visit(value);
}

export function validateRestoreEvidence(
  value: unknown,
  deployed: { releaseSha: string; buildHash: string; serverArtifactSha256: string },
): { rtoMs: number; rpoMs: number } {
  assertSecretFree(value);
  const evidence = object(value, "restore evidence");
  expectEqual(evidence.format, 1, "restore evidence format");
  expectEqual(evidence.conclusion, "passed", "restore evidence conclusion");
  const checks = object(evidence.checks, "restore evidence checks");
  const checksum = object(checks.checksum, "restore checksum");
  expectEqual(checksum.status, "passed", "restore checksum status");
  expectEqual(checksum.algorithm, "sha256", "restore checksum algorithm");
  number(checksum.bytes, "restore checksum bytes");
  hash(checksum.digest, "restore checksum digest");

  const metadata = object(checks.metadata, "restore metadata");
  expectEqual(metadata.status, "passed", "restore metadata status");
  expectEqual(metadata.format, 2, "restore metadata format");
  const metadataDataAsOf = iso(metadata.dataAsOf, "restore metadata dataAsOf");
  const metadataCreatedAt = iso(metadata.backupCreatedAt, "restore metadata backupCreatedAt");

  const integrity = object(checks.integrity, "restore integrity");
  expectEqual(integrity.status, "passed", "restore integrity status");
  expectEqual(integrity.sourceResult, "ok", "restore source integrity result");
  expectEqual(integrity.migratedResult, "ok", "restore migrated integrity result");
  const schema = object(checks.schema, "restore schema");
  expectEqual(schema.status, "passed", "restore schema status");
  const sourceUserVersion = number(schema.sourceUserVersion, "restore source schema version");
  if (
    !Number.isSafeInteger(sourceUserVersion)
    || sourceUserVersion < MIN_SUPPORTED_RESTORE_SOURCE_SCHEMA_VERSION
    || sourceUserVersion > LATEST_SCHEMA_VERSION
  ) throw new Error("restore source schema version is unsupported");
  if (schema.userVersion !== LATEST_SCHEMA_VERSION) {
    throw new Error("restore migrated schema version mismatch");
  }
  const expectedMigration = sourceUserVersion === LATEST_SCHEMA_VERSION
    ? "not_required"
    : "candidate_private_clone";
  if (schema.migration !== expectedMigration) throw new Error("restore migration mode mismatch");
  expectEqual(
    schema.requiredTables,
    RESTORE_REQUIRED_TABLE_COUNT,
    "restore required table coverage",
  );
  expectEqual(
    schema.requiredColumns,
    RESTORE_REQUIRED_COLUMN_COUNT,
    "restore required column coverage",
  );
  const installation = object(checks.installation, "restore installation");
  expectEqual(installation.status, "passed", "restore installation status");
  if (number(installation.activeCount, "restore active installation count") < 1) {
    throw new Error("restore active installation coverage is empty");
  }
  const tokenRead = object(checks.tokenBackedRead, "restore token-backed read");
  expectEqual(tokenRead.status, "passed", "restore token-backed read status");
  expectEqual(tokenRead.endpoint, "GET /user", "restore token-backed read endpoint");
  expectEqual(tokenRead.httpStatus, 200, "restore token-backed read status code");
  expectEqual(tokenRead.redirects, "blocked", "restore token-backed read redirects");

  const readiness = object(checks.applicationReadiness, "restore application readiness");
  expectEqual(readiness.status, "passed", "restore application readiness status");
  expectEqual(readiness.endpoint, "GET /health", "restore application readiness endpoint");
  expectEqual(readiness.httpStatus, 200, "restore application readiness status code");
  expectEqual(readiness.startupInitialization, "production", "restore production initialization");
  expectEqual(readiness.serverArtifact, "dist/server/server.js", "restore server artifact");
  expectEqual(readiness.portBinding, "child_ephemeral_ipc", "restore port binding");
  expectEqual(readiness.releaseSha, deployed.releaseSha, "restore release SHA");
  expectEqual(readiness.releaseBuildHash, deployed.buildHash, "restore build hash");
  if (readiness.serverArtifactSha256 !== deployed.serverArtifactSha256) {
    throw new Error("restore server artifact mismatch");
  }
  const shutdown = object(readiness.shutdownVerification, "restore shutdown verification");
  expectEqual(shutdown.childExitCode, 0, "restore child exit");
  expectEqual(shutdown.databaseIntegrity, "ok", "restore post-exit integrity");
  expectEqual(shutdown.writerLock, "available", "restore writer lock");

  const recovery = object(evidence.recovery, "restore recovery measurements");
  const drillStartedAt = iso(recovery.drillStartedAt, "restore drill start");
  const incidentAt = iso(recovery.incidentAt, "restore incident time");
  const dataAsOf = iso(recovery.dataAsOf, "restore recovery dataAsOf");
  const backupCreatedAt = iso(recovery.backupCreatedAt, "restore recovery backupCreatedAt");
  const readinessConfirmedAt = iso(recovery.readinessConfirmedAt, "restore readiness time");
  expectEqual(dataAsOf, metadataDataAsOf, "restore dataAsOf");
  expectEqual(backupCreatedAt, metadataCreatedAt, "restore backup timestamp");
  const rtoMs = number(recovery.rtoMs, "restore RTO");
  const rpoMs = number(recovery.rpoMs, "restore RPO");
  if (rtoMs !== Date.parse(readinessConfirmedAt) - Date.parse(drillStartedAt)) {
    throw new Error("restore RTO calculation mismatch");
  }
  if (rpoMs !== Date.parse(incidentAt) - Date.parse(dataAsOf)) {
    throw new Error("restore RPO calculation mismatch");
  }
  return { rtoMs, rpoMs };
}

function validateScopeEvidence(input: {
  value: unknown;
  attestationVerification: JsonObject;
  requiredScopes: readonly string[];
  deployed: {
    releaseSha: string;
    buildHash: string;
    serverArtifactSha256: string;
    sourceRelationship: "exact_head" | "evidence_descendant" | "source_bound_builder";
    sourceBindingSha256: string | null;
    manifestSha256: string;
  };
}): { attestationSha256: string; retainedScopeCount: number } {
  assertSecretFree(input.value);
  assertSecretFree(input.attestationVerification);
  const evidence = object(input.value, "scope evidence");
  expectEqual(evidence.schemaVersion, 2, "scope evidence schema");
  expectEqual(evidence.conclusion, "passed", "scope evidence conclusion");
  expectEqual(evidence.releaseSha, input.deployed.releaseSha, "scope release SHA");
  expectEqual(evidence.releaseBuildHash, input.deployed.buildHash, "scope build hash");
  expectEqual(evidence.serverArtifactSha256, input.deployed.serverArtifactSha256, "scope server artifact");
  expectEqual(evidence.sourceRelationship, input.deployed.sourceRelationship, "scope source relationship");
  expectEqual(evidence.sourceBindingSha256, input.deployed.sourceBindingSha256, "scope source binding");
  expectEqual(evidence.manifestSha256, input.deployed.manifestSha256, "scope manifest");
  expectEqual(evidence.auth, "X-Addon-Token", "scope authentication");
  expectEqual(evidence.workspaceBound, true, "scope workspace binding");
  expectEqual(evidence.tokenIncluded, false, "scope token isolation");
  const startedAt = iso(evidence.startedAt, "scope probe start");
  const finishedAt = iso(evidence.finishedAt, "scope probe finish");
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new Error("scope probe timing is malformed");
  }
  const coverage = object(evidence.coverage, "scope coverage");
  expectEqual(coverage.mode, "exact_endpoint_per_scope_fresh_install", "scope coverage mode");
  expectEqual(
    coverage.perScopeNecessity,
    "platform_resource_action_contract",
    "per-scope necessity basis",
  );
  const platformContract = object(coverage.platformContract, "platform scope contract");
  expectEqual(platformContract.source, CLOCKIFY_SCOPE_ENFORCEMENT_SOURCE, "platform scope contract source");
  expectEqual(platformContract.sha256, CLOCKIFY_SCOPE_ENFORCEMENT_SHA256, "platform scope contract hash");

  const freshInstall = object(evidence.freshInstall, "fresh installation attestation");
  if (freshInstall.method !== "authenticated_server_installation_attestation") {
    throw new Error("fresh installation attestation is not authenticated");
  }
  expectEqual(freshInstall.releaseSha, input.deployed.releaseSha, "fresh installation release SHA");
  expectEqual(freshInstall.releaseBuildHash, input.deployed.buildHash, "fresh installation build hash");
  expectEqual(freshInstall.serverArtifactSha256, input.deployed.serverArtifactSha256, "fresh installation server artifact");
  expectEqual(freshInstall.sourceRelationship, input.deployed.sourceRelationship, "fresh installation source relationship");
  expectEqual(freshInstall.sourceBindingSha256, input.deployed.sourceBindingSha256, "fresh installation source binding");
  expectEqual(freshInstall.manifestSha256, input.deployed.manifestSha256, "fresh installation manifest");
  hash(freshInstall.workspaceSha256, "fresh installation workspace hash");
  iso(freshInstall.installedAt, "fresh installation time");
  const ageSeconds = number(freshInstall.ageSeconds, "fresh installation age");
  if (ageSeconds > 15 * 60) throw new Error("fresh installation attestation is stale");
  if (!Number.isInteger(number(freshInstall.installationGeneration, "fresh installation generation"))
      || Number(freshInstall.installationGeneration) < 1) {
    throw new Error("fresh installation generation is malformed");
  }
  const attestationSha256 = hash(freshInstall.attestationSha256, "fresh installation attestation hash");
  expectEqual(freshInstall.remoteVerification, "passed", "fresh installation remote verification");
  const envelope = object(freshInstall.verificationEnvelope, "fresh installation verification envelope");
  expectEqual(envelope.schemaVersion, 1, "fresh installation envelope schema");
  expectEqual(envelope.algorithm, "HMAC-SHA256", "fresh installation envelope algorithm");
  string(envelope.signature, "fresh installation envelope signature");
  const payload = object(envelope.payload, "fresh installation envelope payload");
  if (hashCanonicalJson(payload) !== attestationSha256) {
    throw new Error("fresh installation attestation envelope hash mismatch");
  }
  for (const [field, label] of [
    ["workspaceSha256", "workspace hash"],
    ["installationGeneration", "generation"],
    ["releaseSha", "release SHA"],
    ["releaseBuildHash", "build hash"],
    ["serverArtifactSha256", "server artifact"],
    ["sourceRelationship", "source relationship"],
    ["sourceBindingSha256", "source binding"],
    ["manifestSha256", "manifest"],
    ["installedAt", "installation time"],
  ] as const) {
    expectEqual(payload[field], freshInstall[field], `fresh installation envelope ${label}`);
  }
  const calculatedAgeSeconds = Math.max(
    0,
    Math.floor((Date.parse(startedAt) - Date.parse(String(freshInstall.installedAt))) / 1000),
  );
  if (calculatedAgeSeconds !== ageSeconds) {
    throw new Error("fresh installation age calculation mismatch");
  }

  const remote = object(input.attestationVerification, "remote attestation verification");
  expectEqual(remote.valid, true, "remote installation attestation verification");
  expectEqual(remote.attestationSha256, attestationSha256, "remote installation attestation hash");
  expectEqual(remote.releaseSha, input.deployed.releaseSha, "remote installation release SHA");
  expectEqual(remote.releaseBuildHash, input.deployed.buildHash, "remote installation build hash");
  expectEqual(remote.serverArtifactSha256, input.deployed.serverArtifactSha256, "remote installation server artifact");
  expectEqual(remote.sourceRelationship, input.deployed.sourceRelationship, "remote installation source relationship");
  expectEqual(remote.sourceBindingSha256, input.deployed.sourceBindingSha256, "remote installation source binding");
  expectEqual(remote.manifestSha256, input.deployed.manifestSha256, "remote installation manifest");

  if (!Array.isArray(evidence.results)) throw new Error("scope coverage is malformed");
  const expected = new Set(input.requiredScopes);
  const observed = new Set<string>();
  for (const rawResult of evidence.results) {
    const result = object(rawResult, "scope result");
    const scope = string(result.scope, "scope result name");
    if (!expected.has(scope) || observed.has(scope)) throw new Error("scope coverage mismatch");
    expectEqual(result.verdict, "AUTH_OK", `scope ${scope} authorization`);
    observed.add(scope);
  }
  if (observed.size !== expected.size || [...expected].some((scope) => !observed.has(scope))) {
    throw new Error("scope coverage mismatch");
  }
  const audit = object(evidence.auditHost, "AUDIT host evidence");
  if (audit.host !== "audit" || audit.method !== "POST" || audit.verdict !== "AUTH_OK") {
    throw new Error("AUDIT host clearance failed");
  }
  const auditStatus = audit.status;
  if (
    auditStatus !== "2xx"
    && !(typeof auditStatus === "number" && auditStatus >= 200 && auditStatus < 300)
  ) throw new Error("AUDIT host must return 2xx for the valid read probe");
  expectEqual(audit.key, "workspace_read_audit_host", "AUDIT host evidence key");
  expectEqual(audit.scope, "WORKSPACE_READ", "AUDIT host scope");
  return { attestationSha256, retainedScopeCount: observed.size };
}

export function validateOperationalReleaseEvidence(
  input: OperationalReleaseEvidenceInput,
): OperationalReleaseEvidence {
  const sourceCandidateSha = fullCommit(input.sourceCandidateSha, "source candidate SHA");
  const evidenceCommitSha = fullCommit(input.evidenceCommitSha, "evidence commit SHA");
  const version = object(input.deployedVersion, "deployed version");
  expectEqual(version.version, "1.0.0", "deployed version");
  expectEqual(version.releaseSha, sourceCandidateSha, "deployed release SHA");
  const releaseBuildHash = hash(version.buildHash, "deployed build hash");
  const serverArtifactSha256 = hash(version.serverArtifactSha256, "deployed server artifact");
  const relationship = version.sourceRelationship;
  if (relationship !== "exact_head" && relationship !== "evidence_descendant" && relationship !== "source_bound_builder") {
    throw new Error("deployed source relationship is not independently source-bound");
  }
  const sourceBindingSha256 = relationship === "source_bound_builder"
    ? hash(version.sourceBindingSha256, "deployed source binding")
    : null;
  if (relationship !== "source_bound_builder" && version.sourceBindingSha256 !== null) {
    throw new Error("deployed source binding is inconsistent");
  }
  const manifestSha256 = hashCanonicalJson(input.deployedManifest);
  const deployed = {
    releaseSha: sourceCandidateSha,
    buildHash: releaseBuildHash,
    serverArtifactSha256,
    sourceRelationship: relationship,
    sourceBindingSha256,
    manifestSha256,
  } as const;
  const restore = validateRestoreEvidence(input.restoreEvidence, deployed);
  const scope = validateScopeEvidence({
    value: input.scopeEvidence,
    attestationVerification: input.attestationVerification,
    requiredScopes: input.requiredScopes ?? REQUIRED_SCOPES,
    deployed,
  });
  return {
    schemaVersion: 1,
    conclusion: "passed",
    sourceCandidateSha,
    evidenceCommitSha,
    deployed: {
      releaseBuildHash,
      serverArtifactSha256,
      sourceRelationship: relationship,
      sourceBindingSha256,
      manifestSha256,
    },
    backupRestore: {
      evidenceSha256: hashCanonicalJson(input.restoreEvidence),
      ...restore,
    },
    scopeAndAudit: {
      evidenceSha256: hashCanonicalJson(input.scopeEvidence),
      ...scope,
      auditHost: "AUTH_OK",
    },
  };
}

function readBoundedJson(path: string): JsonObject {
  const absolute = resolve(path);
  if (statSync(absolute).size > MAX_EVIDENCE_BYTES) throw new Error("operational evidence file is too large");
  return object(JSON.parse(readFileSync(absolute, "utf8")) as unknown, "operational evidence file");
}

function runGit(args: readonly string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

export function assertOperationalEvidenceOnlyDescendant(
  sourceCandidateSha: string,
  evidenceCommitSha: string,
): void {
  execFileSync("git", ["merge-base", "--is-ancestor", sourceCandidateSha, evidenceCommitSha]);
  if (sourceCandidateSha === evidenceCommitSha) return;
  const changed = runGit(["diff", "--name-only", `${sourceCandidateSha}..${evidenceCommitSha}`])
    .split("\n")
    .filter(Boolean);
  const forbidden = changed.filter((path) => !ALLOWED_EVIDENCE_DESCENDANT_PATHS.some((prefix) => path.startsWith(prefix)));
  if (forbidden.length > 0) {
    throw new Error(`evidence commit contains non-evidence changes: ${forbidden.join(", ")}`);
  }
}

function writeAtomic(path: string, value: unknown): void {
  const absolute = resolve(path);
  const temporary = `${absolute}.tmp`;
  mkdirSync(dirname(absolute), { recursive: true });
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, absolute);
}

async function main(): Promise<void> {
  const sourceCandidateSha = process.env.OPERATIONAL_EXPECTED_CANDIDATE_SHA ?? "";
  const evidenceCommitSha = process.env.OPERATIONAL_EVIDENCE_COMMIT_SHA ?? "";
  fullCommit(sourceCandidateSha, "source candidate SHA");
  fullCommit(evidenceCommitSha, "evidence commit SHA");
  assertOperationalEvidenceOnlyDescendant(sourceCandidateSha, evidenceCommitSha);
  const result = validateOperationalReleaseEvidence({
    sourceCandidateSha,
    evidenceCommitSha,
    deployedVersion: readBoundedJson(process.env.OPERATIONAL_DEPLOYED_VERSION_PATH ?? "/tmp/operational-deployed-version.json"),
    deployedManifest: readBoundedJson(process.env.OPERATIONAL_DEPLOYED_MANIFEST_PATH ?? "/tmp/operational-deployed-manifest.json"),
    attestationVerification: readBoundedJson(process.env.OPERATIONAL_ATTESTATION_VERIFICATION_PATH ?? "/tmp/operational-attestation-verification.json"),
    restoreEvidence: readBoundedJson(process.env.OPERATIONAL_RESTORE_EVIDENCE_PATH ?? "evidence/operations/production-restore.json"),
    scopeEvidence: readBoundedJson(process.env.OPERATIONAL_SCOPE_EVIDENCE_PATH ?? "evidence/operations/production-scope-probe.json"),
  });
  writeAtomic(process.env.OPERATIONAL_VALIDATION_PATH ?? "/tmp/operational-release-validation.json", result);
  console.log(`Operational release evidence passed for ${result.sourceCandidateSha}.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "operational evidence validation failed";
    console.error(message);
    process.exitCode = 1;
  });
}
