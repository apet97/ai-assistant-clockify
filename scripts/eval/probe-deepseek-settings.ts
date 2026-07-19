/**
 * Secret-free, source-bound DeepSeek capability probe for release evidence.
 * Credentials and provider content are never serialized. The only output is a
 * canonical allowlisted contract describing whether each supported setting was
 * accepted by the current, pinned endpoint.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  assertProductionDeepSeekConfiguration,
  modelChatCompletionsUrl,
  modelEndpointSha256,
} from "../../src/assistant/model-endpoint.js";

type Classification = "distinct-passing" | "compatibility-alias" | "unsupported";

interface ProbeCase {
  setting: string;
  classification: Classification;
  reasoningEffort?: string;
  thinking?: "disabled";
}

interface DeepSeekResponse {
  choices?: unknown[];
}

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const releaseSha = process.env.EVAL_RELEASE_CANDIDATE_SHA?.trim();
const baseUrl = process.env.LLM_BASE_URL?.trim();
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL?.trim();
const outArgument = process.argv.slice(2).find((arg) => arg.startsWith("--out="))?.slice("--out=".length);

if (!releaseSha || !SHA_PATTERN.test(releaseSha)) {
  throw new Error("EVAL_RELEASE_CANDIDATE_SHA must be a full lowercase commit SHA");
}
if (process.versions.node.split(".")[0] !== "22") throw new Error("release capability probe requires Node 22");
if (!baseUrl || !apiKey || !model) throw new Error("LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL are required");
if (!outArgument || !isAbsolute(outArgument)) {
  throw new Error("release capability probe requires an absolute --out path");
}
assertProductionDeepSeekConfiguration({ provider: "http", baseUrl, model });

const worktree = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const outputPath = resolve(outArgument);
const fromWorktree = relative(worktree, outputPath);
if (fromWorktree === "" || (!fromWorktree.startsWith("..") && !isAbsolute(fromWorktree))) {
  throw new Error("release capability probe output must be outside the Git worktree");
}

function assertCleanSource(): void {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
  if (head !== releaseSha || status !== "") {
    throw new Error("release capability probe requires the exact clean candidate checkout");
  }
}

assertCleanSource();
const startedAt = new Date().toISOString();
const cases: ProbeCase[] = [
  { setting: "production-default", classification: "distinct-passing" },
  { setting: "reasoning-high", classification: "compatibility-alias", reasoningEffort: "high" },
  { setting: "reasoning-medium", classification: "compatibility-alias", reasoningEffort: "medium" },
  { setting: "reasoning-low", classification: "compatibility-alias", reasoningEffort: "low" },
  { setting: "reasoning-none", classification: "unsupported", reasoningEffort: "none" },
  { setting: "thinking-disabled", classification: "distinct-passing", thinking: "disabled" },
];

const endpoint = modelChatCompletionsUrl(baseUrl);
const settings: Array<{
  setting: string;
  classification: Classification;
  accepted: boolean;
  httpStatus: number;
}> = [];
for (const probe of cases) {
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      max_tokens: 128,
      ...(probe.reasoningEffort ? { reasoning_effort: probe.reasoningEffort } : {}),
      ...(probe.thinking ? { thinking: { type: probe.thinking } } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  let body: DeepSeekResponse = {};
  try {
    body = await response.json() as DeepSeekResponse;
  } catch {
    // Provider content is deliberately discarded. A malformed response is not accepted.
  }
  settings.push({
    setting: probe.setting,
    classification: probe.classification,
    accepted: response.ok && Array.isArray(body.choices),
    httpStatus: response.status,
  });
}

const completedAt = new Date().toISOString();
assertCleanSource();
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify({
  schemaVersion: 1,
  kind: "deepseek-capability-probe",
  startedAt,
  completedAt,
  source: { gitCommitSha: releaseSha, workingTreeClean: true },
  runtimeConfiguration: {
    provider: "http",
    model,
    endpointSha256: modelEndpointSha256(baseUrl),
    mode: "tool",
    agentic: true,
    toolSelect: true,
    reasoningEffort: null,
    thinkingMode: null,
    concurrency: 1,
    nodeVersion: process.version,
    timeoutMs: 120_000,
    seed: null,
    mixedTier: false,
  },
  settings,
  distinctPassingSettings: ["production-default", "thinking-disabled"],
}, null, 2)}\n`);
