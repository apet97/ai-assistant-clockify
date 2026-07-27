import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FEATURE_GROUPS } from "../../src/harness/permissions.js";
import { hashCanonicalJson } from "../lib/live-evidence.js";
import {
  classifyHistoricalV1Evidence,
  type EvidenceTargetAssistantEngine,
  type HistoricalV1EvidenceClassification,
} from "./release-evidence.js";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BROWSER_VERSION_PATTERN = /^\d+(?:\.\d+){1,4}$/u;
const MAX_EVIDENCE_BYTES = 1_048_576;
const MAX_RUN_MS = 4 * 60 * 60 * 1_000;

type JsonObject = Record<string, unknown>;
type SourceRelationship = "exact_head" | "evidence_descendant" | "source_bound_builder";

export interface LiveEvidenceSource {
  commitSha: string;
  releaseBuildHash: string;
  serverArtifactSha256: string;
  sourceRelationship: SourceRelationship;
  sourceBindingSha256: string | null;
}

export interface MemberDenialEvidence {
  schemaVersion: 1;
  kind: "production_member_denial";
  conclusion: "passed";
  source: LiveEvidenceSource;
  observedAt: string;
  role: "MEMBER";
  authorityPath: "verified_installation_to_member_exchange";
  componentStatus: 403;
  sessionCookieIssued: false;
  adminOnlyResponse: true;
}

export interface LiveBrowserAcceptanceEvidence {
  schemaVersion: 1;
  kind: "production_browser_acceptance";
  conclusion: "passed";
  source: LiveEvidenceSource;
  startedAt: string;
  completedAt: string;
  deployedVersionObservedAt: string;
  runtime: {
    browser: "Google Chrome";
    browserVersion: string;
    surface: "clockify_embedded_iframe";
  };
  journeys: {
    firstRun: { disclosureVisible: true; permissionsSaved: true; permissionGroupCount: number };
    admin: { componentLoaded: true; role: "OWNER" | "ADMIN" };
    read: { receiptVisible: true };
    safeWrite: { receiptVisible: true };
    undo: { receiptVisible: true; effectAbsent: true };
    riskyCancel: { previewVisible: true; cancelled: true; effectPreserved: true };
    riskyConfirm: { previewVisible: true; confirmed: true; receiptVisible: true; effectAbsent: true };
    history: { conversationSwitched: true; contentRestored: true };
    reload: { contentRestored: true; operationCardsRestored: true };
    pdf: {
      actionVisible: true;
      downloadCompleted: true;
      filenameExtension: ".pdf";
      contentType: "application/pdf";
      signature: "%PDF-";
      bytes: number;
      authenticatedStatus: 200;
      unauthenticatedStatus: 401;
    };
  };
  cleanup: {
    resourcePrefix: "AIASSIST_SMOKE_";
    created: number;
    deletionProven: number;
    remaining: 0;
    pendingPreviews: 0;
  };
  capture: {
    artifactType: "browser_automation_trace";
    sha256: string;
    secretReview: "passed";
  };
  memberDenialEvidenceSha256: string;
}

export interface LiveBrowserAcceptanceValidation extends HistoricalV1EvidenceClassification {
  schemaVersion: 1;
  conclusion: "passed";
  sourceCandidateSha: string;
  releaseBuildHash: string;
  serverArtifactSha256: string;
  sourceRelationship: SourceRelationship;
  sourceBindingSha256: string | null;
  browser: "Google Chrome";
  browserVersion: string;
  surface: "clockify_embedded_iframe";
  startedAt: string;
  completedAt: string;
  journeyCount: 10;
  memberDenial: "passed";
  memberDenialEvidenceSha256: string;
  captureSha256: string;
  cleanup: LiveBrowserAcceptanceEvidence["cleanup"];
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys are malformed`);
  }
}

function fullCommit(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) throw new Error(`${label} is malformed`);
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new Error(`${label} is malformed`);
  return value;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`${label} is malformed`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} is malformed`);
  return Number(value);
}

function exactTrue(value: unknown, label: string): void {
  if (value !== true) throw new Error(`${label} did not pass`);
}

function source(value: unknown, label: string): LiveEvidenceSource {
  const row = object(value, label);
  exactKeys(row, [
    "commitSha",
    "releaseBuildHash",
    "serverArtifactSha256",
    "sourceRelationship",
    "sourceBindingSha256",
  ], label);
  const relationship = row.sourceRelationship;
  if (relationship !== "exact_head" && relationship !== "evidence_descendant" && relationship !== "source_bound_builder") {
    throw new Error(`${label} source relationship is malformed`);
  }
  const binding = relationship === "source_bound_builder"
    ? sha256(row.sourceBindingSha256, `${label} source binding`)
    : null;
  if (relationship !== "source_bound_builder" && row.sourceBindingSha256 !== null) {
    throw new Error(`${label} source binding is inconsistent`);
  }
  return {
    commitSha: fullCommit(row.commitSha, `${label} commit`),
    releaseBuildHash: sha256(row.releaseBuildHash, `${label} build`),
    serverArtifactSha256: sha256(row.serverArtifactSha256, `${label} runtime artifact`),
    sourceRelationship: relationship,
    sourceBindingSha256: binding,
  };
}

function assertNoSecrets(value: unknown): void {
  const forbiddenKey = /(?:addonToken|apiKey|workspaceId|userId|memberId|resourceId|componentUrl|authToken|prompt|requestBody|responseBody|headers?)$/iu;
  const visit = (child: unknown): void => {
    if (typeof child === "string") {
      if (/https?:\/\//iu.test(child) || /\bBearer\s+/iu.test(child) || /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u.test(child)) {
        throw new Error("live browser evidence is not secret-free");
      }
      return;
    }
    if (Array.isArray(child)) {
      for (const value of child) visit(value);
      return;
    }
    if (!child || typeof child !== "object") return;
    for (const [key, nested] of Object.entries(child as JsonObject)) {
      if (forbiddenKey.test(key)) throw new Error("live browser evidence is not secret-free");
      visit(nested);
    }
  };
  visit(value);
}

function validateDeployedSource(value: unknown, expected: LiveEvidenceSource): void {
  const deployed = object(value, "deployed version");
  if (
    deployed.version !== "1.0.0"
    || deployed.releaseSha !== expected.commitSha
    || deployed.buildHash !== expected.releaseBuildHash
    || deployed.serverArtifactSha256 !== expected.serverArtifactSha256
    || deployed.sourceRelationship !== expected.sourceRelationship
    || deployed.sourceBindingSha256 !== expected.sourceBindingSha256
  ) throw new Error("live browser deployment binding mismatch");
}

function sourceFromDeployedVersion(value: unknown, expectedCandidateSha: string): LiveEvidenceSource {
  const deployed = object(value, "deployed version");
  const relationship = deployed.sourceRelationship;
  if (
    deployed.version !== "1.0.0"
    || deployed.releaseSha !== expectedCandidateSha
    || (relationship !== "exact_head" && relationship !== "evidence_descendant" && relationship !== "source_bound_builder")
  ) throw new Error("live browser deployment binding mismatch");
  const binding = relationship === "source_bound_builder"
    ? sha256(deployed.sourceBindingSha256, "deployed source binding")
    : null;
  if (relationship !== "source_bound_builder" && deployed.sourceBindingSha256 !== null) {
    throw new Error("live browser deployment binding mismatch");
  }
  return {
    commitSha: fullCommit(deployed.releaseSha, "deployed candidate SHA"),
    releaseBuildHash: sha256(deployed.buildHash, "deployed build hash"),
    serverArtifactSha256: sha256(deployed.serverArtifactSha256, "deployed runtime artifact"),
    sourceRelationship: relationship,
    sourceBindingSha256: binding,
  };
}

function validateMemberDenial(value: unknown, expectedSource: LiveEvidenceSource): MemberDenialEvidence {
  assertNoSecrets(value);
  const row = object(value, "member denial evidence");
  exactKeys(row, [
    "schemaVersion",
    "kind",
    "conclusion",
    "source",
    "observedAt",
    "role",
    "authorityPath",
    "componentStatus",
    "sessionCookieIssued",
    "adminOnlyResponse",
  ], "member denial evidence");
  const actualSource = source(row.source, "member denial source");
  if (JSON.stringify(actualSource) !== JSON.stringify(expectedSource)) throw new Error("member denial source mismatch");
  if (
    row.schemaVersion !== 1
    || row.kind !== "production_member_denial"
    || row.conclusion !== "passed"
    || row.role !== "MEMBER"
    || row.authorityPath !== "verified_installation_to_member_exchange"
    || row.componentStatus !== 403
    || row.sessionCookieIssued !== false
    || row.adminOnlyResponse !== true
  ) throw new Error("member denial proof did not pass");
  iso(row.observedAt, "member denial observation time");
  return row as unknown as MemberDenialEvidence;
}

function validateJourneys(value: unknown): LiveBrowserAcceptanceEvidence["journeys"] {
  const journeys = object(value, "browser journeys");
  exactKeys(journeys, [
    "firstRun", "admin", "read", "safeWrite", "undo", "riskyCancel", "riskyConfirm", "history", "reload", "pdf",
  ], "browser journeys");

  const firstRun = object(journeys.firstRun, "first-run journey");
  exactKeys(firstRun, ["disclosureVisible", "permissionsSaved", "permissionGroupCount"], "first-run journey");
  exactTrue(firstRun.disclosureVisible, "first-run disclosure");
  exactTrue(firstRun.permissionsSaved, "first-run permissions");
  if (firstRun.permissionGroupCount !== FEATURE_GROUPS.length) throw new Error("first-run permission journey is incomplete");

  const admin = object(journeys.admin, "admin journey");
  exactKeys(admin, ["componentLoaded", "role"], "admin journey");
  exactTrue(admin.componentLoaded, "admin component");
  if (admin.role !== "OWNER" && admin.role !== "ADMIN") throw new Error("admin journey role is invalid");

  const read = object(journeys.read, "read journey");
  exactKeys(read, ["receiptVisible"], "read journey");
  exactTrue(read.receiptVisible, "read journey");
  const safeWrite = object(journeys.safeWrite, "safe-write journey");
  exactKeys(safeWrite, ["receiptVisible"], "safe-write journey");
  exactTrue(safeWrite.receiptVisible, "safe-write journey");
  const undo = object(journeys.undo, "undo journey");
  exactKeys(undo, ["receiptVisible", "effectAbsent"], "undo journey");
  exactTrue(undo.receiptVisible, "undo receipt");
  exactTrue(undo.effectAbsent, "undo host effect");

  const riskyCancel = object(journeys.riskyCancel, "risky-cancel journey");
  exactKeys(riskyCancel, ["previewVisible", "cancelled", "effectPreserved"], "risky-cancel journey");
  exactTrue(riskyCancel.previewVisible, "risky-cancel preview");
  exactTrue(riskyCancel.cancelled, "risky cancellation");
  exactTrue(riskyCancel.effectPreserved, "risky-cancel host effect");

  const riskyConfirm = object(journeys.riskyConfirm, "risky-confirm journey");
  exactKeys(riskyConfirm, ["previewVisible", "confirmed", "receiptVisible", "effectAbsent"], "risky-confirm journey");
  exactTrue(riskyConfirm.previewVisible, "risky-confirm preview");
  exactTrue(riskyConfirm.confirmed, "risky confirmation");
  exactTrue(riskyConfirm.receiptVisible, "risky-confirm receipt");
  exactTrue(riskyConfirm.effectAbsent, "risky-confirm host effect");

  const history = object(journeys.history, "history journey");
  exactKeys(history, ["conversationSwitched", "contentRestored"], "history journey");
  exactTrue(history.conversationSwitched, "history switch");
  exactTrue(history.contentRestored, "history restore");
  const reload = object(journeys.reload, "reload journey");
  exactKeys(reload, ["contentRestored", "operationCardsRestored"], "reload journey");
  exactTrue(reload.contentRestored, "reload content");
  exactTrue(reload.operationCardsRestored, "reload operation cards");

  const pdf = object(journeys.pdf, "PDF journey");
  exactKeys(pdf, [
    "actionVisible", "downloadCompleted", "filenameExtension", "contentType", "signature", "bytes", "authenticatedStatus", "unauthenticatedStatus",
  ], "PDF journey");
  exactTrue(pdf.actionVisible, "PDF action");
  exactTrue(pdf.downloadCompleted, "PDF download");
  if (
    pdf.filenameExtension !== ".pdf"
    || pdf.contentType !== "application/pdf"
    || pdf.signature !== "%PDF-"
    || nonNegativeInteger(pdf.bytes, "PDF bytes") < 5
    || pdf.authenticatedStatus !== 200
    || pdf.unauthenticatedStatus !== 401
  ) throw new Error("PDF journey did not prove authenticated bytes");

  return journeys as unknown as LiveBrowserAcceptanceEvidence["journeys"];
}

/** Build the final importable artifact from a single strict, sanitized browser
 * automation result. Source/artifact fields and the member hash are always
 * derived here; the browser runner cannot author or override them. */
export function recordLiveBrowserAcceptanceEvidence(input: {
  trace: unknown;
  traceSha256: string;
  memberDenialEvidence: unknown;
  deployedVersion: unknown;
  expectedCandidateSha: string;
}, targetAssistantEngine: EvidenceTargetAssistantEngine = "v1"): LiveBrowserAcceptanceEvidence {
  classifyHistoricalV1Evidence(targetAssistantEngine);
  assertNoSecrets(input.trace);
  const trace = object(input.trace, "sanitized browser trace");
  exactKeys(trace, [
    "schemaVersion",
    "kind",
    "startedAt",
    "completedAt",
    "deployedVersionObservedAt",
    "runtime",
    "journeys",
    "cleanup",
  ], "sanitized browser trace");
  if (trace.schemaVersion !== 1 || trace.kind !== "sanitized_browser_automation_trace") {
    throw new Error("sanitized browser trace is malformed");
  }
  const expectedCandidateSha = fullCommit(input.expectedCandidateSha, "expected candidate SHA");
  const evidenceSource = sourceFromDeployedVersion(input.deployedVersion, expectedCandidateSha);
  const member = validateMemberDenial(input.memberDenialEvidence, evidenceSource);
  const evidence: LiveBrowserAcceptanceEvidence = {
    schemaVersion: 1,
    kind: "production_browser_acceptance",
    conclusion: "passed",
    source: evidenceSource,
    startedAt: trace.startedAt as string,
    completedAt: trace.completedAt as string,
    deployedVersionObservedAt: trace.deployedVersionObservedAt as string,
    runtime: trace.runtime as LiveBrowserAcceptanceEvidence["runtime"],
    journeys: trace.journeys as LiveBrowserAcceptanceEvidence["journeys"],
    cleanup: trace.cleanup as LiveBrowserAcceptanceEvidence["cleanup"],
    capture: {
      artifactType: "browser_automation_trace",
      sha256: sha256(input.traceSha256, "browser trace hash"),
      secretReview: "passed",
    },
    memberDenialEvidenceSha256: hashCanonicalJson(member),
  };
  validateLiveBrowserAcceptanceEvidence({
    evidence,
    memberDenialEvidence: member,
    deployedVersion: input.deployedVersion,
    expectedCandidateSha,
  }, targetAssistantEngine);
  return evidence;
}

export function validateLiveBrowserAcceptanceEvidence(input: {
  evidence: unknown;
  memberDenialEvidence: unknown;
  deployedVersion: unknown;
  expectedCandidateSha: string;
}, targetAssistantEngine: EvidenceTargetAssistantEngine = "v1"): LiveBrowserAcceptanceValidation {
  const classification = classifyHistoricalV1Evidence(targetAssistantEngine);
  assertNoSecrets(input.evidence);
  const row = object(input.evidence, "live browser evidence");
  exactKeys(row, [
    "schemaVersion",
    "kind",
    "conclusion",
    "source",
    "startedAt",
    "completedAt",
    "deployedVersionObservedAt",
    "runtime",
    "journeys",
    "cleanup",
    "capture",
    "memberDenialEvidenceSha256",
  ], "live browser evidence");
  if (row.schemaVersion !== 1 || row.kind !== "production_browser_acceptance" || row.conclusion !== "passed") {
    throw new Error("live browser evidence did not pass");
  }
  const expectedCandidateSha = fullCommit(input.expectedCandidateSha, "expected candidate SHA");
  const evidenceSource = source(row.source, "live browser source");
  if (evidenceSource.commitSha !== expectedCandidateSha) throw new Error("live browser candidate mismatch");
  validateDeployedSource(input.deployedVersion, evidenceSource);

  const startedAt = iso(row.startedAt, "live browser start time");
  const completedAt = iso(row.completedAt, "live browser completion time");
  const deployedVersionObservedAt = iso(row.deployedVersionObservedAt, "deployed version observation time");
  const startMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  const observedVersionMs = Date.parse(deployedVersionObservedAt);
  if (completedMs < startMs || completedMs - startMs > MAX_RUN_MS || observedVersionMs < startMs || observedVersionMs > completedMs) {
    throw new Error("live browser evidence time window is invalid");
  }

  const runtime = object(row.runtime, "browser runtime");
  exactKeys(runtime, ["browser", "browserVersion", "surface"], "browser runtime");
  if (
    runtime.browser !== "Google Chrome"
    || typeof runtime.browserVersion !== "string"
    || !BROWSER_VERSION_PATTERN.test(runtime.browserVersion)
    || runtime.surface !== "clockify_embedded_iframe"
  ) throw new Error("browser runtime is invalid");
  validateJourneys(row.journeys);

  const cleanup = object(row.cleanup, "browser cleanup");
  exactKeys(cleanup, ["resourcePrefix", "created", "deletionProven", "remaining", "pendingPreviews"], "browser cleanup");
  const created = nonNegativeInteger(cleanup.created, "browser cleanup created count");
  const deletionProven = nonNegativeInteger(cleanup.deletionProven, "browser cleanup deletion count");
  if (
    cleanup.resourcePrefix !== "AIASSIST_SMOKE_"
    || created < 2
    || deletionProven !== created
    || cleanup.remaining !== 0
    || cleanup.pendingPreviews !== 0
  ) throw new Error("browser cleanup proof is incomplete");

  const capture = object(row.capture, "browser capture");
  exactKeys(capture, ["artifactType", "sha256", "secretReview"], "browser capture");
  if (capture.artifactType !== "browser_automation_trace" || capture.secretReview !== "passed") {
    throw new Error("browser capture proof is incomplete");
  }
  const captureSha256 = sha256(capture.sha256, "browser capture hash");

  const member = validateMemberDenial(input.memberDenialEvidence, evidenceSource);
  const memberHash = sha256(row.memberDenialEvidenceSha256, "member denial evidence hash");
  if (hashCanonicalJson(member) !== memberHash) throw new Error("member denial evidence hash mismatch");
  const memberObservedMs = Date.parse(member.observedAt);
  if (memberObservedMs < startMs || memberObservedMs > completedMs) throw new Error("member denial evidence time mismatch");

  return {
    ...classification,
    schemaVersion: 1,
    conclusion: "passed",
    sourceCandidateSha: expectedCandidateSha,
    releaseBuildHash: evidenceSource.releaseBuildHash,
    serverArtifactSha256: evidenceSource.serverArtifactSha256,
    sourceRelationship: evidenceSource.sourceRelationship,
    sourceBindingSha256: evidenceSource.sourceBindingSha256,
    browser: "Google Chrome",
    browserVersion: runtime.browserVersion,
    surface: "clockify_embedded_iframe",
    startedAt,
    completedAt,
    journeyCount: 10,
    memberDenial: "passed",
    memberDenialEvidenceSha256: memberHash,
    captureSha256,
    cleanup: {
      resourcePrefix: "AIASSIST_SMOKE_",
      created,
      deletionProven,
      remaining: 0,
      pendingPreviews: 0,
    },
  };
}

/** Validate the retained, reviewable sanitized trace as the exact source of the
 * final browser evidence. This deliberately does not claim cryptographic proof
 * of who drove Chrome; it prevents an unreviewable digest from being treated as
 * evidence by requiring CI to possess, parse, secret-scan, reproduce, and
 * upload the exact bytes whose SHA-256 is recorded in the final artifact. */
export function validateLiveBrowserAcceptanceEvidenceWithTrace(input: {
  evidence: unknown;
  traceBytes: Uint8Array;
  memberDenialEvidence: unknown;
  deployedVersion: unknown;
  expectedCandidateSha: string;
}, targetAssistantEngine: EvidenceTargetAssistantEngine = "v1"): LiveBrowserAcceptanceValidation {
  classifyHistoricalV1Evidence(targetAssistantEngine);
  let traceText: string;
  let trace: unknown;
  try {
    traceText = new TextDecoder("utf-8", { fatal: true }).decode(input.traceBytes);
    trace = JSON.parse(traceText) as unknown;
  } catch {
    throw new Error("retained browser trace is malformed");
  }
  const traceSha256 = createHash("sha256").update(input.traceBytes).digest("hex");
  const reproduced = recordLiveBrowserAcceptanceEvidence({
    trace,
    traceSha256,
    memberDenialEvidence: input.memberDenialEvidence,
    deployedVersion: input.deployedVersion,
    expectedCandidateSha: input.expectedCandidateSha,
  }, targetAssistantEngine);
  if (hashCanonicalJson(reproduced) !== hashCanonicalJson(input.evidence)) {
    throw new Error("retained browser trace does not reproduce final evidence");
  }
  return validateLiveBrowserAcceptanceEvidence({
    evidence: input.evidence,
    memberDenialEvidence: input.memberDenialEvidence,
    deployedVersion: input.deployedVersion,
    expectedCandidateSha: input.expectedCandidateSha,
  }, targetAssistantEngine);
}

export function isLiveBrowserEvidencePath(path: string): boolean {
  return path === "evidence/operations/production-browser.json"
    || path === "evidence/operations/production-browser-trace.json"
    || path === "evidence/operations/production-member-denial.json";
}

export function assertLiveBrowserEvidenceOnlyDescendant(
  sourceCandidateSha: string,
  evidenceCommitSha: string,
  cwd = process.cwd(),
): void {
  execFileSync("git", ["merge-base", "--is-ancestor", sourceCandidateSha, evidenceCommitSha], { cwd });
  if (sourceCandidateSha === evidenceCommitSha) return;
  const changed = execFileSync("git", ["diff", "--name-only", `${sourceCandidateSha}..${evidenceCommitSha}`], {
    cwd,
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean);
  const forbidden = changed.filter((path) => !path.startsWith("evidence/") && !path.startsWith("docs/marketplace/evidence/"));
  if (forbidden.length > 0) throw new Error("live browser evidence commit contains non-evidence changes");
}

function readBoundedBytes(path: string): Buffer {
  const absolute = resolve(path);
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_EVIDENCE_BYTES) {
    throw new Error("live browser evidence file is unsafe");
  }
  return readFileSync(absolute);
}

function readBoundedJson(path: string): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readBoundedBytes(path))) as unknown;
}

function writeAtomic(path: string, value: unknown): void {
  const absolute = resolve(path);
  const temporary = `${absolute}.tmp`;
  mkdirSync(dirname(absolute), { recursive: true });
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, absolute);
}

function main(): void {
  const sourceCandidateSha = process.env.LIVE_BROWSER_EXPECTED_CANDIDATE_SHA ?? "";
  const evidenceCommitSha = process.env.LIVE_BROWSER_EVIDENCE_COMMIT_SHA ?? "";
  fullCommit(sourceCandidateSha, "expected candidate SHA");
  fullCommit(evidenceCommitSha, "evidence commit SHA");
  assertLiveBrowserEvidenceOnlyDescendant(sourceCandidateSha, evidenceCommitSha);
  const result = validateLiveBrowserAcceptanceEvidenceWithTrace({
    evidence: readBoundedJson(process.env.LIVE_BROWSER_EVIDENCE_PATH ?? "evidence/operations/production-browser.json"),
    traceBytes: readBoundedBytes(
      process.env.LIVE_BROWSER_TRACE_PATH ?? "evidence/operations/production-browser-trace.json",
    ),
    memberDenialEvidence: readBoundedJson(
      process.env.MEMBER_DENIAL_EVIDENCE_PATH ?? "evidence/operations/production-member-denial.json",
    ),
    deployedVersion: readBoundedJson(
      process.env.LIVE_BROWSER_DEPLOYED_VERSION_PATH ?? "/tmp/live-browser-deployed-version.json",
    ),
    expectedCandidateSha: sourceCandidateSha,
  }, "v1");
  writeAtomic(process.env.LIVE_BROWSER_VALIDATION_PATH ?? "/tmp/live-browser-acceptance-validation.json", result);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    process.stderr.write("Live browser acceptance validation failed\n");
    process.exitCode = 1;
  }
}
