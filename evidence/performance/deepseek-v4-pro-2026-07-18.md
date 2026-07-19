# DeepSeek V4-Pro release benchmark — 2026-07-18

> Historical engineering benchmark only. It is not release-gate evidence and
> the machine gate does not consume this Markdown or its companion summary JSON.
> Its historical `thinking=disabled` selection is superseded: two later
> independent exact-source diagnostic cohorts passed production-default 55/55
> but the lower-effort setting only 54/55, failing the same supported invoice
> case with zero safety violations. Release eligibility and the current setting
> come only from fresh, checked-in raw aggregates and their machine binding.

This is the secret-free Phase 2 release benchmark for the production model
configuration. It used Node 22, HTTP tool mode, `LLM_AGENTIC=1`,
`LLM_TOOL_SELECT=1`, the real `deepseek-v4-pro` endpoint, the real action harness,
and the fake Clockify workspace. No API key, prompt text, model response, tool
arguments, token, or header is stored in this evidence.

The worktree was on `codex/marketplace-1.0.0`, based on
`3ec78ac19458347b0b1de3e340c592f8a08f9bb7`. The final release evidence must bind
this benchmark to the final candidate commit after the branch is committed.

## Provider setting reality

Production was observed on Railway project `ai-assistant-clockify`, environment
`production`, service `ai-assistant`, using `api.deepseek.com` and
`deepseek-v4-pro`. Provider, mode, agentic loop, and tool selection resolve to
their `http`, `tool`, `1`, and `1` defaults. Both reasoning effort and thinking
mode were unset, so DeepSeek used its documented default: thinking enabled at
high effort.

DeepSeek's current API documentation defines `high` and `max` as the distinct
reasoning efforts. `low` and `medium` are compatibility aliases mapped to
`high`, so they are not genuinely lower settings. A live, sanitized probe
confirmed that `reasoning_effort=none` returns HTTP 400
`invalid_request_error`; `thinking: {"type":"disabled"}` returns HTTP 200 with
no reasoning-token count. Therefore non-thinking mode is the only genuinely
lower supported comparison. See DeepSeek's [Thinking Mode guide](https://api-docs.deepseek.com/guides/thinking_mode),
[Chat Completion contract](https://api-docs.deepseek.com/api/create-chat-completion/),
and [cache pricing](https://api-docs.deepseek.com/quick_start/pricing).

## Five consecutive safety corpora

Each setting ran the complete 11-case configured agentic corpus five consecutive
times. The aggregate p50/p95 below is calculated over all 55 case-runs, not over
the five already-aggregated summaries.

| Setting | Pass | Write-safety violations | p50 | p95 | Prompt cache | Completion tokens |
|---|---:|---:|---:|---:|---:|---:|
| Production default (thinking/high) | 55/55 | 0 | 4,370 ms | 7,242 ms | 950,656 / 964,809 (98.53%) | 10,686 |
| `thinking=disabled` | 55/55 | 0 | 4,076 ms | 7,354 ms | 991,872 / 1,000,666 (99.12%) | 6,704 |

The supported non-thinking mode reduced median latency by 6.73% and completion
tokens by 37.27%. Its p95 increased by 1.55%, safely below the 10% regression
guard. Both settings passed every run with zero write-safety regression.

The five candidate runs were individually 11/11 with zero safety violations;
their p50/p95 pairs were 3,923/8,227, 4,120/6,602, 4,386/6,097,
3,620/7,399, and 3,826/7,354 ms.

## Focused selected-setting gates

| Gate | Samples | Result | p50 | p95 | Limit |
|---|---:|---:|---:|---:|---:|
| Scripted read turn | 20 | 20/20, 0 safety | 2,908 ms | 3,316 ms | <12,000 ms |
| Risky write preview, no commit | 20 | 20/20, 0 safety | 1,665 ms | 1,919 ms | <18,000 ms |

At the time of this historical snapshot, those measurements selected
`LLM_THINKING_MODE=disabled`. That conclusion is superseded by the later repeated
functional miss described above. The 1.0.0 candidate therefore uses
production-default reasoning (`LLM_THINKING_MODE` unset) unless the final-source
machine selector proves a different fully passing result. DeepSeek V4-Pro, HTTP
tool mode, the agentic loop, and tool selection remain unchanged.

After that production config path was implemented, a separate real-provider
proof using `LLM_THINKING_MODE=disabled` (not the eval-only override) produced
the risky preview in 1,514 ms, passed 1/1 with zero safety violations, committed
nothing, and reported 6,656 cached tokens out of 6,706 prompt tokens.

## Reproduction

Credentials are injected by Railway and never echoed. Release raw aggregates are
written outside the checkout so the evaluator can prove the tested candidate is
clean. The checked-in binding records SHA-256 digests for the two 55-run corpora,
the 20-sample read-only gate, and the 20-sample risky-preview gate. The validator
recomputes every pass, safety, cache-token, median, and p95 conclusion; it also
requires the focused runs to use the exact candidate SHA and proves one preview
and zero commits in every risky sample.

```bash
# From the clean release-candidate checkout. Never write raw output into it.
test -z "$(git status --porcelain)"
export EVAL_RELEASE_CANDIDATE_SHA="$(git rev-parse HEAD)"
export DEEPSEEK_RAW_DIR="$(mktemp -d /tmp/ai-assistant-deepseek.XXXXXX)"
export DEEPSEEK_CAPABILITY_PROBE_RAW_PATH="$DEEPSEEK_RAW_DIR/capability-probe.raw.json"
export DEEPSEEK_BASELINE_RAW_PATH="$DEEPSEEK_RAW_DIR/baseline.raw.json"
export DEEPSEEK_CANDIDATE_RAW_PATH="$DEEPSEEK_RAW_DIR/candidate.raw.json"
export DEEPSEEK_FOCUSED_READ_RAW_PATH="$DEEPSEEK_RAW_DIR/focused-read.raw.json"
export DEEPSEEK_FOCUSED_RISKY_PREVIEW_RAW_PATH="$DEEPSEEK_RAW_DIR/focused-risky-preview.raw.json"
export DEEPSEEK_BINDING_PATH="evidence/performance/deepseek-release-binding.json"

railway run --service ai-assistant --environment production -- \
  npx tsx scripts/eval/probe-deepseek-settings.ts \
  --out="$DEEPSEEK_CAPABILITY_PROBE_RAW_PATH"

railway run --service ai-assistant --environment production -- \
  env -u LLM_THINKING_MODE -u EVAL_DEEPSEEK_THINKING_MODE \
  npx tsx scripts/eval-agentic.ts --repeat=5 --concurrency=4 --tool-select \
  --out="$DEEPSEEK_BASELINE_RAW_PATH"

set +e
railway run --service ai-assistant --environment production -- \
  env LLM_THINKING_MODE=disabled EVAL_DEEPSEEK_THINKING_MODE=disabled \
  npx tsx scripts/eval-agentic.ts --repeat=5 --concurrency=4 --tool-select \
  --out="$DEEPSEEK_CANDIDATE_RAW_PATH"
export DEEPSEEK_CANDIDATE_EXIT_STATUS="$?"
set -e
test -s "$DEEPSEEK_CANDIDATE_RAW_PATH"
SELECTED_DEEPSEEK_SETTING="$(npx tsx scripts/evidence/deepseek-release-evidence.ts --select-setting)"
case "$SELECTED_DEEPSEEK_SETTING" in
  production-default)
    SELECTED_ENV=(env -u LLM_THINKING_MODE -u EVAL_DEEPSEEK_THINKING_MODE)
    ;;
  thinking-disabled)
    test "$DEEPSEEK_CANDIDATE_EXIT_STATUS" = 0
    SELECTED_ENV=(env LLM_THINKING_MODE=disabled EVAL_DEEPSEEK_THINKING_MODE=disabled)
    ;;
  *) exit 1 ;;
esac

railway run --service ai-assistant --environment production -- \
  "${SELECTED_ENV[@]}" \
  npx tsx scripts/eval-agentic.ts --repeat=20 --only=agentic.count_projects \
  --concurrency=4 --tool-select \
  --out="$DEEPSEEK_FOCUSED_READ_RAW_PATH"

railway run --service ai-assistant --environment production -- \
  "${SELECTED_ENV[@]}" \
  npx tsx scripts/eval-agentic.ts --repeat=20 --only=agentic.delete_tag_by_name \
  --concurrency=4 --tool-select --preview-only \
  --out="$DEEPSEEK_FOCUSED_RISKY_PREVIEW_RAW_PATH"

npm run bind:deepseek-evidence
cp "$DEEPSEEK_CAPABILITY_PROBE_RAW_PATH" evidence/performance/deepseek-capability-probe.raw.json
cp "$DEEPSEEK_BASELINE_RAW_PATH" evidence/performance/deepseek-baseline.raw.json
cp "$DEEPSEEK_CANDIDATE_RAW_PATH" evidence/performance/deepseek-candidate.raw.json
cp "$DEEPSEEK_FOCUSED_READ_RAW_PATH" evidence/performance/deepseek-focused-read.raw.json
cp "$DEEPSEEK_FOCUSED_RISKY_PREVIEW_RAW_PATH" evidence/performance/deepseek-focused-risky-preview.raw.json
```

Railway was not mutated during benchmarking. Do not use this historical snapshot
to change production configuration; follow the strict selector and deployment
procedure in [`DEPLOYMENT.md`](../../DEPLOYMENT.md).
