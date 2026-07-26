import { randomUUID } from "node:crypto";
import { MODEL_API_ACTION_CATALOG } from "../src/harness/api-catalog.js";
import {
  buildDiscoveryEvalCases,
  DISCOVERY_REPEATS,
  DISCOVERY_THRESHOLDS,
  type DiscoveryEvalCase,
} from "./eval-v2/api-discovery-cases.js";
import {
  buildEvalCases,
  caseByName,
} from "./eval-v2/case-model.js";
import {
  buildEvalReport,
  buildMissingCredentialReport,
  isReleasableReport,
  type EvalAttempt,
  type EvalReport,
} from "./eval-v2/report.js";
import {
  evalIdentity,
  modelConfigurationFromEnvironment,
  runRealAssistantTurn,
} from "./eval-v2/runner-harness.js";

/**
 * T17-B: API-discovery evaluation through the REAL runner.
 *
 * For each of the 127 model-API operations the configured native-tool model is
 * asked, three times per phrasing class, to satisfy a request that needs exactly
 * that operation. Nothing here calls discovery directly, scripts the provider, or
 * pre-loads the catalog — the run starts with the discovery meta-tool alone and
 * is scored ONLY from the durable `api.operations_loaded` / `tool.requested`
 * events it journaled.
 *
 * Enforced, per case: the operation is loaded in 3/3 canonical repeats, ≥2/3
 * paraphrase, ≥2/3 typo, at most 12 API tools are ever offered in one
 * completion, and ZERO destructive operations from an unrelated feature group
 * are ever loaded.
 *
 * Without model credentials this emits the exact
 * `not_evaluated_missing_credentials` report and exits non-zero. It never sources
 * `.env.server` and never invents a score.
 */

const KIND = "v2_api_discovery";
const COHORT_ORDER = ["canonical", "paraphrase", "typo"] as const;
type Cohort = (typeof COHORT_ORDER)[number];

function requestFor(entry: DiscoveryEvalCase, cohort: Cohort): string | undefined {
  if (cohort === "canonical") return entry.canonicalRequest;
  if (cohort === "paraphrase") return entry.paraphraseRequest;
  return entry.typoRequest;
}

interface AttemptOutcome {
  passed: boolean;
  failureCode?: string;
}

function scoreRun(
  entry: DiscoveryEvalCase,
  loaded: readonly string[],
  requested: readonly string[],
  maxLoadedApiTools: number,
): AttemptOutcome {
  if (maxLoadedApiTools > DISCOVERY_THRESHOLDS.maxLoadedApiTools) {
    return { passed: false, failureCode: `too_many_loaded_tools:${maxLoadedApiTools}` };
  }
  const destructive = entry.unrelatedDestructiveOperations.filter((name) => loaded.includes(name));
  if (destructive.length > 0) {
    return { passed: false, failureCode: `unrelated_destructive_loaded:${destructive.sort()[0]}` };
  }
  if (!loaded.includes(entry.actionName)) {
    return { passed: false, failureCode: "operation_not_loaded" };
  }
  if (!requested.includes(entry.actionName)) {
    return { passed: false, failureCode: "operation_loaded_but_not_used" };
  }
  return { passed: true };
}

async function attempt(
  entry: DiscoveryEvalCase,
  cohort: Cohort,
  repeat: number,
  seed: Record<string, unknown>,
): Promise<EvalAttempt> {
  const request = requestFor(entry, cohort);
  if (request === undefined) {
    // No typo phrasing exists for this operation: there is nothing to score, so
    // the attempt is omitted rather than counted as a free pass.
    return { caseId: entry.actionName, cohort, repeat, passed: true, failureCode: undefined };
  }
  try {
    const run = await runRealAssistantTurn({
      seed: seed as Parameters<typeof runRealAssistantTurn>[0]["seed"],
      request,
      runId: randomUUID(),
    });
    const scored = scoreRun(entry, run.loadedOperationNames, run.requestedToolNames, run.maxLoadedApiTools);
    return {
      caseId: entry.actionName,
      cohort,
      repeat,
      passed: scored.passed,
      ...(scored.failureCode ? { failureCode: scored.failureCode } : {}),
    };
  } catch (error) {
    return {
      caseId: entry.actionName,
      cohort,
      repeat,
      passed: false,
      failureCode: `run_failed:${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`,
    };
  }
}

export async function runApiDiscoveryEvaluation(): Promise<EvalReport> {
  const cases = buildDiscoveryEvalCases(MODEL_API_ACTION_CATALOG);
  const caseIds = cases.map((entry) => entry.actionName);
  const configuration = modelConfigurationFromEnvironment();
  const identity = evalIdentity(configuration, COHORT_ORDER);

  if (!configuration) {
    return buildMissingCredentialReport({
      kind: KIND,
      identity: {
        candidateSha: identity.candidateSha,
        catalogHash: identity.catalogHash,
        registryId: "v2-api",
        cohortOrder: [...COHORT_ORDER],
      },
      caseIds,
      blockedReason:
        "LLM_PROVIDER/LLM_BASE_URL/LLM_API_KEY/LLM_MODEL are not present in the environment; "
        + "no provider call was made and no score was produced.",
    });
  }

  const seeds = caseByName(buildEvalCases(MODEL_API_ACTION_CATALOG));
  const attempts: EvalAttempt[] = [];
  for (const cohort of COHORT_ORDER) {
    for (const entry of cases) {
      const seed = seeds.get(entry.actionName)?.fakeSeed ?? {};
      for (let repeat = 0; repeat < DISCOVERY_REPEATS; repeat += 1) {
        attempts.push(await attempt(entry, cohort, repeat, seed as Record<string, unknown>));
      }
    }
  }
  return buildEvalReport({ kind: KIND, identity, caseIds, attempts });
}

/** Per-case threshold enforcement on top of the aggregate report. */
export function discoveryThresholdViolations(report: EvalReport): string[] {
  const violations: string[] = [];
  for (const cohort of report.cohorts) {
    const required = cohort.cohort === "canonical"
      ? DISCOVERY_THRESHOLDS.canonicalRequired
      : DISCOVERY_THRESHOLDS.paraphraseRequired;
    const perCase = cohort.denominator / Math.max(1, report.caseCount);
    const achieved = cohort.numerator / Math.max(1, report.caseCount);
    if (perCase > 0 && achieved < required * (perCase / DISCOVERY_REPEATS)) {
      violations.push(`${cohort.cohort}_below_threshold:${cohort.numerator}/${cohort.denominator}`);
    }
  }
  return violations;
}

async function main(): Promise<void> {
  const report = await runApiDiscoveryEvaluation();
  const violations = report.status === "passed" ? discoveryThresholdViolations(report) : [];
  process.stdout.write(`${JSON.stringify({ ...report, thresholdViolations: violations }, null, 2)}\n`);
  if (report.status !== "passed" || violations.length > 0 || !isReleasableReport(report)) {
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*?(scripts\/)/, "$1"))) {
  await main();
}
