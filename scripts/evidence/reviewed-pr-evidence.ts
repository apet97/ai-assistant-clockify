import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { writeDeterministicJson } from "./write-json.js";

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REQUIRED_CI_JOBS = ["browser-e2e", "dependency-review", "secret-scan", "verify"] as const;
const REQUIRED_CODEQL_JOBS = ["analyze"] as const;

export interface ReviewedPullRequestEvidence {
  schemaVersion: 1;
  conclusion: "passed";
  repository: string;
  sourceCandidateSha: string;
  evidenceCommitSha: string;
  pullRequest: {
    number: number;
    url: string;
    baseRefName: "main";
    headSha: string;
    state: "OPEN" | "MERGED";
    reviewDecision: "APPROVED";
    unresolvedReviewThreads: 0;
  };
  ciRun: {
    id: number;
    url: string;
    headSha: string;
    attempt: 1;
    requiredJobs: readonly string[];
  };
  codeqlRun: {
    id: number;
    url: string;
    headSha: string;
    attempt: 1;
    requiredJobs: readonly string[];
  };
}

export interface ReviewedPullRequestValidationInput {
  repository: string;
  sourceCandidateSha: string;
  evidenceCommitSha: string;
  pullRequestNumber: number;
  ciRunId: number;
  codeqlRunId: number;
  pullRequest: unknown;
  ciRun: unknown;
  ciJobs: unknown;
  codeqlRun: unknown;
  codeqlJobs: unknown;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function fullSha(value: string, label: string): string {
  if (!SHA_PATTERN.test(value)) throw new Error(`${label} must be a full lowercase Git SHA`);
  return value;
}

function exact(value: unknown, expected: unknown, label: string): void {
  if (value !== expected) throw new Error(`${label} must equal ${String(expected)}`);
}

function githubUrl(value: unknown, repository: string, label: string): string {
  const url = string(value, label);
  const prefix = `https://github.com/${repository}/`;
  if (!url.startsWith(prefix)) throw new Error(`${label} must belong to the reviewed repository`);
  return url;
}

function validateJobs(value: unknown, required: readonly string[], label: string): readonly string[] {
  const collection = object(value, `${label} jobs`);
  const jobs = array(collection.jobs, `${label} jobs list`).map((job, index) => object(job, `${label} job ${index + 1}`));
  exact(positiveInteger(collection.total_count, `${label} total job count`), jobs.length, `${label} complete job count`);
  for (const name of required) {
    const matching = jobs.filter((job) => job.name === name);
    if (matching.length !== 1) throw new Error(`${label} must contain exactly one ${name} job`);
    exact(matching[0]!.conclusion, "success", `${label} ${name} conclusion`);
  }
  return [...required];
}

function validateRun(
  value: unknown,
  expected: { id: number; repository: string; name: string; path: string; headSha: string },
  requiredJobs: readonly string[],
  jobs: unknown,
  label: string,
): ReviewedPullRequestEvidence["ciRun"] {
  const run = object(value, `${label} run`);
  exact(positiveInteger(run.id, `${label} run id`), expected.id, `${label} run id`);
  exact(run.name, expected.name, `${label} workflow name`);
  exact(run.path, expected.path, `${label} workflow path`);
  exact(run.event, "pull_request", `${label} event`);
  exact(run.status, "completed", `${label} status`);
  exact(run.conclusion, "success", `${label} conclusion`);
  exact(run.head_sha, expected.headSha, `${label} head SHA`);
  exact(run.run_attempt, 1, `${label} run attempt`);
  return {
    id: expected.id,
    url: githubUrl(run.html_url, expected.repository, `${label} URL`),
    headSha: expected.headSha,
    attempt: 1,
    requiredJobs: validateJobs(jobs, requiredJobs, label),
  };
}

export function validateReviewedPullRequestEvidence(
  input: ReviewedPullRequestValidationInput,
): ReviewedPullRequestEvidence {
  if (!REPOSITORY_PATTERN.test(input.repository)) throw new Error("reviewed repository is invalid");
  const sourceCandidateSha = fullSha(input.sourceCandidateSha, "reviewed source candidate SHA");
  const evidenceCommitSha = fullSha(input.evidenceCommitSha, "reviewed evidence commit SHA");
  const pullRequestNumber = positiveInteger(input.pullRequestNumber, "pull request number");
  const ciRunId = positiveInteger(input.ciRunId, "CI run id");
  const codeqlRunId = positiveInteger(input.codeqlRunId, "CodeQL run id");

  const pullRequest = object(input.pullRequest, "reviewed pull request");
  exact(positiveInteger(pullRequest.number, "reviewed pull request number"), pullRequestNumber, "reviewed pull request number");
  exact(pullRequest.isDraft, false, "reviewed pull request draft state");
  exact(pullRequest.baseRefName, "main", "reviewed pull request base");
  exact(pullRequest.headRefOid, evidenceCommitSha, "reviewed pull request head SHA");
  exact(pullRequest.reviewDecision, "APPROVED", "reviewed pull request decision");
  const state = string(pullRequest.state, "reviewed pull request state");
  const merged = pullRequest.merged === true;
  if (state !== "OPEN" && !(state === "CLOSED" && merged)) {
    throw new Error("reviewed pull request must remain open or be merged");
  }
  const threads = object(pullRequest.reviewThreads, "review threads");
  const pageInfo = object(threads.pageInfo, "review thread page info");
  exact(pageInfo.hasNextPage, false, "review thread pagination");
  const unresolved = array(threads.nodes, "review threads").filter((thread, index) => {
    const row = object(thread, `review thread ${index + 1}`);
    if (typeof row.isResolved !== "boolean") throw new Error(`review thread ${index + 1} resolution is invalid`);
    return !row.isResolved;
  }).length;
  if (unresolved !== 0) throw new Error("reviewed pull request has unresolved review threads");

  const ciRun = validateRun(input.ciRun, {
    id: ciRunId,
    repository: input.repository,
    name: "CI",
    path: ".github/workflows/ci.yml",
    headSha: evidenceCommitSha,
  }, REQUIRED_CI_JOBS, input.ciJobs, "pull-request CI");
  const codeqlRun = validateRun(input.codeqlRun, {
    id: codeqlRunId,
    repository: input.repository,
    name: "CodeQL",
    path: ".github/workflows/codeql.yml",
    headSha: evidenceCommitSha,
  }, REQUIRED_CODEQL_JOBS, input.codeqlJobs, "pull-request CodeQL");

  return {
    schemaVersion: 1,
    conclusion: "passed",
    repository: input.repository,
    sourceCandidateSha,
    evidenceCommitSha,
    pullRequest: {
      number: pullRequestNumber,
      url: githubUrl(pullRequest.url, input.repository, "reviewed pull request URL"),
      baseRefName: "main",
      headSha: evidenceCommitSha,
      state: merged ? "MERGED" : "OPEN",
      reviewDecision: "APPROVED",
      unresolvedReviewThreads: 0,
    },
    ciRun,
    codeqlRun,
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function environmentInteger(name: string): number {
  const raw = requiredEnvironment(name);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  return positiveInteger(Number(raw), name);
}

async function githubJson(url: string, token: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {}),
    },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`GitHub API request failed with ${response.status}`);
  return await response.json() as unknown;
}

async function fetchPullRequest(repository: string, number: number, token: string): Promise<unknown> {
  const [owner, name] = repository.split("/") as [string, string];
  const query = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        number url state isDraft merged baseRefName headRefOid reviewDecision
        reviewThreads(first: 100) { nodes { isResolved } pageInfo { hasNextPage } }
      }
    }
  }`;
  const payload = await githubJson("https://api.github.com/graphql", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { owner, name, number } }),
  });
  const response = object(payload, "GitHub GraphQL response");
  const data = object(response.data, "GitHub GraphQL data");
  const repo = object(data.repository, "GitHub GraphQL repository");
  return object(repo.pullRequest, "GitHub GraphQL pull request");
}

function assertEvidenceOnlyReviewedHead(sourceCandidateSha: string, evidenceCommitSha: string): void {
  const git = (args: string[]): string => execFileSync("git", args, { encoding: "utf8" }).trim();
  exact(git(["rev-parse", "HEAD"]), evidenceCommitSha, "reviewed evidence checkout");
  if (git(["status", "--porcelain", "--untracked-files=all"]) !== "") {
    throw new Error("reviewed PR validation requires a clean checkout");
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sourceCandidateSha, evidenceCommitSha], { stdio: "ignore" });
  } catch {
    throw new Error("reviewed PR head must descend from the source candidate");
  }
  if (sourceCandidateSha === evidenceCommitSha) return;
  const changed = git(["diff", "--name-only", `${sourceCandidateSha}..${evidenceCommitSha}`]).split("\n").filter(Boolean);
  const forbidden = changed.filter((path) => !path.startsWith("evidence/") && !path.startsWith("docs/marketplace/evidence/"));
  if (forbidden.length > 0) throw new Error(`reviewed PR descendant contains executable changes: ${forbidden.join(", ")}`);
}

async function main(): Promise<void> {
  const token = requiredEnvironment("GITHUB_TOKEN");
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const sourceCandidateSha = requiredEnvironment("RELEASE_SOURCE_CANDIDATE_SHA");
  const evidenceCommitSha = requiredEnvironment("RELEASE_EVIDENCE_COMMIT_SHA");
  const pullRequestNumber = environmentInteger("REVIEWED_PR_NUMBER");
  const ciRunId = environmentInteger("REVIEWED_PR_CI_RUN_ID");
  const codeqlRunId = environmentInteger("REVIEWED_PR_CODEQL_RUN_ID");
  assertEvidenceOnlyReviewedHead(sourceCandidateSha, evidenceCommitSha);
  const api = `https://api.github.com/repos/${repository}`;
  const [pullRequest, ciRun, ciJobs, codeqlRun, codeqlJobs] = await Promise.all([
    fetchPullRequest(repository, pullRequestNumber, token),
    githubJson(`${api}/actions/runs/${ciRunId}`, token),
    githubJson(`${api}/actions/runs/${ciRunId}/jobs?filter=latest&per_page=100`, token),
    githubJson(`${api}/actions/runs/${codeqlRunId}`, token),
    githubJson(`${api}/actions/runs/${codeqlRunId}/jobs?filter=latest&per_page=100`, token),
  ]);
  const evidence = validateReviewedPullRequestEvidence({
    repository,
    sourceCandidateSha,
    evidenceCommitSha,
    pullRequestNumber,
    ciRunId,
    codeqlRunId,
    pullRequest,
    ciRun,
    ciJobs,
    codeqlRun,
    codeqlJobs,
  });
  writeDeterministicJson(requiredEnvironment("REVIEWED_PR_EVIDENCE_PATH"), evidence);
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) appendFileSync(githubOutput, `reviewed_pr_evidence=${JSON.stringify(evidence)}\n`, "utf8");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "reviewed pull request evidence failed"}\n`);
    process.exitCode = 1;
  });
}
