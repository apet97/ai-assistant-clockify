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
import { emitEvalReport, evalEvidenceSink } from "./eval-v2/evidence-path.js";

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
 *
 * Plan B4: when `EVAL_API_DISCOVERY_EVIDENCE_PATH` is set, the report printed
 * to stdout is ALSO written byte-identically to that path (mode 0600, existing
 * file refused) via the shared evidence-path contract.
 */

const KIND = "v2_api_discovery";
const EVIDENCE_PATH_VARIABLE = "EVAL_API_DISCOVERY_EVIDENCE_PATH";
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

export function scoreRun(
  entry: DiscoveryEvalCase,
  loaded: readonly string[],
  requested: readonly string[],
  prepared: readonly string[],
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
  if (!requested.includes(entry.actionName) && !prepared.includes(entry.actionName)) {
    return { passed: false, failureCode: "operation_loaded_but_not_used" };
  }
  return { passed: true };
}

async function attempt(
  entry: DiscoveryEvalCase,
  cohort: Cohort,
  repeat: number,
  seed: Record<string, unknown>,
): Promise<EvalAttempt | undefined> {
  const request = requestFor(entry, cohort);
  if (request === undefined) {
    // No phrasing exists for this cohort, so there is nothing to score. Return
    // `undefined` and let the caller OMIT the attempt — an earlier version
    // returned `passed: true` here, which would have inflated the numerator
    // (pre-T18 review; currently unreachable, since all 127 cases have a typo).
    return undefined;
  }
  try {
    const run = await runRealAssistantTurn({
      seed: seed as Parameters<typeof runRealAssistantTurn>[0]["seed"],
      request,
      runId: randomUUID(),
    });
    const scored = scoreRun(
      entry,
      run.loadedOperationNames,
      run.requestedToolNames,
      run.preparedWriteActionNames,
      run.maxLoadedApiTools,
    );
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
        const scored = await attempt(entry, cohort, repeat, seed as Record<string, unknown>);
        if (scored) attempts.push(scored);
      }
    }
  }
  return buildEvalReport({ kind: KIND, identity, caseIds, attempts });
}

/**
 * Per-CASE threshold enforcement. The aggregate report already requires every
 * attempt to pass, so this exists to name the exact cases that fell below their
 * cohort floor rather than to relax anything: a cohort average could otherwise
 * mask one case at 0/3 behind others at 3/3 (pre-T18 review).
 */
export function discoveryThresholdViolations(report: EvalReport): string[] {
  const perCase = new Map<string, { cohort: string; passed: number }>();
  for (const cohort of report.cohorts) {
    for (const caseId of cohort.failedCaseIds) {
      perCase.set(`${caseId}|${cohort.cohort}`, { cohort: cohort.cohort, passed: 0 });
    }
  }
  const violations: string[] = [];
  for (const [key, entry] of perCase) {
    const required = entry.cohort === "canonical"
      ? DISCOVERY_THRESHOLDS.canonicalRequired
      : DISCOVERY_THRESHOLDS.paraphraseRequired;
    violations.push(`${key.split("|")[0]}:${entry.cohort}_below_${required}_of_${DISCOVERY_REPEATS}`);
  }
  return violations.sort();
}

export async function main(): Promise<void> {
  const report = await runApiDiscoveryEvaluation();
  const violations = discoveryThresholdViolations(report);
  emitEvalReport({ ...report, thresholdViolations: violations }, evalEvidenceSink(EVIDENCE_PATH_VARIABLE));
  if (report.status !== "passed" || violations.length > 0 || !isReleasableReport(report)) {
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*?(scripts\/)/, "$1"))) {
  await main();
}
