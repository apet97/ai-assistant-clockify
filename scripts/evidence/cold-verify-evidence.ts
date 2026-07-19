import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { writeDeterministicJson } from "./write-json.js";

export const MINIMUM_RELEASE_TESTS = 2_366;

interface VitestJsonReport {
  numTotalTestSuites: number;
  numPassedTestSuites: number;
  numFailedTestSuites: number;
  numPendingTestSuites: number;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  success?: boolean;
}

export interface ColdVerifyPassEvidence {
  pass: number;
  reportSha256: string;
  totalTests: number;
  passedTests: number;
  failedTests: 0;
  pendingTests: 0;
  todoTests: 0;
}

export interface ColdVerifyEvidence {
  schemaVersion: 1;
  conclusion: "passed";
  sourceCandidateSha: string;
  evidenceCommitSha: string;
  node: string;
  minimumPassedTests: typeof MINIMUM_RELEASE_TESTS;
  consecutiveColdPasses: 3;
  retries: 0;
  passes: [ColdVerifyPassEvidence, ColdVerifyPassEvidence, ColdVerifyPassEvidence];
  startedAt?: string;
  completedAt?: string;
}

export interface ColdVerifyEvidenceInput {
  sourceCandidateSha: string;
  evidenceCommitSha: string;
  nodeVersion: string;
  retries: number;
  reports: unknown[];
  reportBytes: Array<NodeJS.ArrayBufferView>;
  startedAt?: string;
  completedAt?: string;
}

const SHA_PATTERN = /^[a-f0-9]{40}$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return value;
}

function fullSha(value: string, label: string): string {
  if (!SHA_PATTERN.test(value)) throw new Error(`${label} must be a full lowercase Git SHA`);
  return value;
}

function iso(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
  return value;
}

function parseReport(value: unknown, pass: number, bytes: NodeJS.ArrayBufferView): ColdVerifyPassEvidence {
  const report = object(value, `cold verify pass ${pass} Vitest report`);
  const counts: VitestJsonReport = {
    numTotalTestSuites: nonnegativeInteger(report.numTotalTestSuites, `pass ${pass} total suites`),
    numPassedTestSuites: nonnegativeInteger(report.numPassedTestSuites, `pass ${pass} passed suites`),
    numFailedTestSuites: nonnegativeInteger(report.numFailedTestSuites, `pass ${pass} failed suites`),
    numPendingTestSuites: nonnegativeInteger(report.numPendingTestSuites, `pass ${pass} pending suites`),
    numTotalTests: nonnegativeInteger(report.numTotalTests, `pass ${pass} total tests`),
    numPassedTests: nonnegativeInteger(report.numPassedTests, `pass ${pass} passed tests`),
    numFailedTests: nonnegativeInteger(report.numFailedTests, `pass ${pass} failed tests`),
    numPendingTests: nonnegativeInteger(report.numPendingTests, `pass ${pass} pending tests`),
    numTodoTests: nonnegativeInteger(report.numTodoTests, `pass ${pass} todo tests`),
    ...(typeof report.success === "boolean" ? { success: report.success } : {}),
  };
  if (
    counts.numTotalTests < MINIMUM_RELEASE_TESTS
    || counts.numPassedTests !== counts.numTotalTests
    || counts.numFailedTests !== 0
    || counts.numPendingTests !== 0
    || counts.numTodoTests !== 0
    || counts.numPassedTestSuites !== counts.numTotalTestSuites
    || counts.numFailedTestSuites !== 0
    || counts.numPendingTestSuites !== 0
    || counts.success !== true
  ) {
    throw new Error(`cold verify pass ${pass} does not satisfy the complete deterministic suite contract`);
  }
  return {
    pass,
    reportSha256: createHash("sha256").update(bytes).digest("hex"),
    totalTests: counts.numTotalTests,
    passedTests: counts.numPassedTests,
    failedTests: 0,
    pendingTests: 0,
    todoTests: 0,
  };
}

export function buildColdVerifyEvidence(input: ColdVerifyEvidenceInput): ColdVerifyEvidence {
  const sourceCandidateSha = fullSha(input.sourceCandidateSha, "cold verify source candidate SHA");
  const evidenceCommitSha = fullSha(input.evidenceCommitSha, "cold verify evidence commit SHA");
  if (!/^v22\.[0-9]+\.[0-9]+$/.test(input.nodeVersion)) {
    throw new Error("cold verification must run on Node 22");
  }
  if (input.retries !== 0) throw new Error("cold verification retries must remain zero");
  if (input.reports.length !== 3 || input.reportBytes.length !== 3) {
    throw new Error("exactly three cold Vitest reports are required");
  }
  const passes = input.reports.map((report, index) => parseReport(report, index + 1, input.reportBytes[index]!));
  const startedAt = iso(input.startedAt, "cold verify start");
  const completedAt = iso(input.completedAt, "cold verify completion");
  if (startedAt !== undefined && completedAt !== undefined && Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new Error("cold verify completion precedes its start");
  }
  return {
    schemaVersion: 1,
    conclusion: "passed",
    sourceCandidateSha,
    evidenceCommitSha,
    node: input.nodeVersion,
    minimumPassedTests: MINIMUM_RELEASE_TESTS,
    consecutiveColdPasses: 3,
    retries: 0,
    passes: passes as ColdVerifyEvidence["passes"],
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function main(): void {
  const paths = [1, 2, 3].map((pass) => requiredEnvironment(`VITEST_RELEASE_REPORT_${pass}`));
  const reportBytes = paths.map((path) => readFileSync(path));
  const evidence = buildColdVerifyEvidence({
    sourceCandidateSha: requiredEnvironment("RELEASE_SOURCE_CANDIDATE_SHA"),
    evidenceCommitSha: requiredEnvironment("RELEASE_EVIDENCE_COMMIT_SHA"),
    nodeVersion: process.version,
    retries: 0,
    reports: reportBytes.map((bytes) => JSON.parse(bytes.toString("utf8")) as unknown),
    reportBytes,
    startedAt: requiredEnvironment("COLD_VERIFY_STARTED_AT"),
    completedAt: requiredEnvironment("COLD_VERIFY_COMPLETED_AT"),
  });
  writeDeterministicJson(requiredEnvironment("VERIFY_EVIDENCE_PATH"), evidence);
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `cold_verifies=${JSON.stringify(evidence)}\n`, "utf8");
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "cold verify evidence failed"}\n`);
    process.exitCode = 1;
  }
}
