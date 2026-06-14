export const meta = {
  name: 'ship-plans-and-review',
  description: 'Land plans 001-006 on main (sequential TDD, one focused commit per plan, push after each), run the full live battery on the sacrificial workspace, adversarially review the changes + the safety/money/auth surfaces, TDD-fix every confirmed finding (one commit each), and push main. Fully resumable: every change is a green commit gated on the prior HEAD, so a re-run skips landed work.',
  whenToUse: 'Execute the plans/ backlog (001-006) end-to-end on main with live validation + an adversarial review pass, then push. Requires a clean tree + green verify to start. The chat-history-switcher feature (007/008) is a SEPARATE workflow run AFTER this one (008 depends on 006).',
  phases: [
    { title: 'Preflight', detail: 'clean main, green verify, live/model/sacrificial-WS capability flags' },
    { title: 'Plans', detail: 'plans 001-006 sequential TDD, one focused commit per plan, HEAD-gated' },
    { title: 'Evidence', detail: 'full live battery (sequential) in parallel with the adversarial reviewers' },
    { title: 'Verify findings', detail: 'one adversarial refuter per finding — confirm only what survives a repro' },
    { title: 'Fix', detail: 'strictly sequential TDD fix loop, one commit per confirmed finding' },
    { title: 'Push', detail: 'final gate (verify + cycles) + push main' },
    { title: 'Report', detail: 'summary: plans landed, battery, findings, fixes, push' },
  ],
}

// ---------------------------------------------------------------- constants

const REPO = '/Users/15x/Downloads/WORKING/addons-me/ai-assistant-addon'
const WORKSPACE_ID = '65b382b606de527a7ee2b60e' // the sacrificial workspace ("WORKSPACE", a dev/test account) — the ONLY workspace live tests may hit

const RULES = `
Repo: ${REPO} — run every command from this directory; paths are relative to it. This is a deployed Clockify marketplace add-on; the preview->confirm safety boundary (src/harness/*) is sacred.
HARD PROHIBITIONS (no exceptions, even if it would "help"):
- NEVER print, echo, log, or quote VALUES from .env / .env.server / any token / secret / auth header. Check key PRESENCE only (e.g. grep -c '^LLM_API_KEY=' .env.server). Never "git add" .env*, data/, eval-results/, or dist/.
- NEVER run scripts/dev-tunnel.sh with any subcommand other than "status" (restart/up rotate the tunnel URL and break the install). If something needs the server and it's down, record it skipped — do NOT start anything.
- Judge gates by EXIT CODE, never by piping through grep. Cautionary tale from this repo: a "verify | grep" pipeline once masked a real tsc failure. Run "npm run verify > /tmp/x.log 2>&1; echo EXIT=$?".
- COMMIT DIRECTLY TO main. NEVER create or switch git branches (no "git checkout -b/-B", "git switch -c", "git branch <name>"). Any "Branch advisor/… / direct-commit per your workflow" line in a plan's Git-workflow section is OVERRIDDEN — this run commits to main and stays on main. (A prior run leaked work onto an advisor/ branch by obeying that line.)
- Verify counts/claims BY EXECUTION, not by grep alone. Your final output is consumed by an orchestrator SCRIPT, not a human — return exactly the structured shape requested.`

const READ_ONLY = `
You are READ-ONLY with respect to the repo: you may run TARGETED tests (single files), tsx probes, curl, and git read commands — but you must NOT edit/create/delete any repo file, and must NOT run the full "npm run verify" or the whole vitest suite (the live battery is running concurrently; don't CPU-starve it). "npx vitest run tests/unit/foo.test.ts" is fine.`

// ---------------------------------------------------------------- schemas

const PREFLIGHT_SCHEMA = {
  type: 'object',
  required: ['ok', 'headSha', 'treeClean', 'verifyGreen'],
  properties: {
    ok: { type: 'boolean' },
    headSha: { type: 'string', description: 'short HEAD sha of main at start' },
    treeClean: { type: 'boolean' },
    verifyGreen: { type: 'boolean' },
    testCount: { type: ['number', 'null'] },
    madgeCycles: { type: ['number', 'null'] },
    caps: {
      type: 'object',
      properties: { live: { type: 'boolean' }, model: { type: 'boolean' }, wsMatches: { type: 'boolean' } },
    },
    warnings: { type: 'array', items: { type: 'string' } },
    abortReason: { type: ['string', 'null'] },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['planId', 'status', 'attempts', 'treeClean'],
  properties: {
    planId: { type: 'string' },
    status: { enum: ['done', 'blocked', 'blocked_safety', 'skipped'] },
    preconditionFailed: { type: 'boolean' },
    finalCommitSha: { type: ['string', 'null'], description: 'short sha of the LAST commit this plan landed (HEAD after the plan)' },
    commitCount: { type: ['number', 'null'] },
    testFiles: { type: 'array', items: { type: 'string' } },
    touchedPaths: { type: 'array', items: { type: 'string' } },
    attempts: { type: 'number' },
    treeClean: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  },
}

const FINDING_ITEM = {
  type: 'object',
  required: ['dimension', 'title', 'severity', 'confidence', 'files', 'evidence', 'expected', 'actual', 'proposedFix'],
  properties: {
    dimension: { type: 'string' },
    title: { type: 'string', description: 'one line, imperative' },
    severity: { enum: ['critical', 'high', 'medium', 'low'] },
    confidence: { enum: ['high', 'medium', 'low'] },
    files: { type: 'array', items: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, lines: { type: 'string' } } } },
    evidence: { type: 'string', description: 'quoted code/output — mandatory, no vibes' },
    reproCommand: { type: ['string', 'null'] },
    expected: { type: 'string' },
    actual: { type: 'string' },
    proposedFix: {
      type: 'object',
      required: ['summary', 'touchPaths'],
      properties: {
        summary: { type: 'string' },
        failingTestFirst: { type: ['string', 'null'], description: 'sketch of the failing test, or null for a pure doc/config fix' },
        touchPaths: { type: 'array', items: { type: 'string' } },
      },
    },
  },
}

const BATTERY_SCHEMA = {
  type: 'object',
  required: ['script', 'status', 'summaryLine', 'findings'],
  properties: {
    script: { type: 'string' },
    status: { enum: ['pass', 'fail', 'skipped'] },
    exitCode: { type: ['number', 'null'] },
    summaryLine: { type: 'string', description: 'the verbatim summary marker line(s)' },
    skipReason: { type: ['string', 'null'] },
    metrics: { type: ['object', 'null'] },
    findings: { type: 'array', items: FINDING_ITEM },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['dimension', 'findings'],
  properties: { dimension: { type: 'string' }, findings: { type: 'array', items: FINDING_ITEM } },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['status', 'reasoning'],
  properties: {
    status: { enum: ['confirmed', 'refuted', 'unverifiable', 'duplicate'] },
    severityFinal: { enum: ['critical', 'high', 'medium', 'low'] },
    reasoning: { type: 'string' },
    refuterEvidence: { type: 'string' },
    reproOutput: { type: ['string', 'null'] },
    duplicateOf: { type: ['string', 'null'] },
  },
}

const FIX_SCHEMA = {
  type: 'object',
  required: ['findingId', 'status', 'attempts', 'treeClean'],
  properties: {
    findingId: { type: 'string' },
    status: { enum: ['fixed', 'blocked', 'blocked_safety', 'wont_fix'] },
    preconditionFailed: { type: 'boolean' },
    commitSha: { type: ['string', 'null'] },
    testFile: { type: ['string', 'null'] },
    touchedPaths: { type: 'array', items: { type: 'string' } },
    attempts: { type: 'number' },
    treeClean: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  },
}

const GATE_SCHEMA = {
  type: 'object',
  required: ['pass', 'madgeCycles', 'headSha'],
  properties: {
    pass: { type: 'boolean' },
    testCount: { type: ['number', 'null'] },
    madgeCycles: { type: 'number' },
    headSha: { type: 'string' },
    pushed: { type: 'boolean', description: 'git push origin main succeeded' },
    pushNote: { type: ['string', 'null'] },
    failures: { type: ['string', 'null'] },
  },
}

// ---------------------------------------------------------------- helpers

function trunc(s, n) { return typeof s === 'string' && s.length > n ? s.slice(0, n) + ' …[truncated]' : s }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }
function findingBrief(f) {
  return { id: f.id, dimension: f.dimension, title: f.title, severity: f.severity, files: f.files, evidence: trunc(f.evidence, 800), reproCommand: f.reproCommand || null, expected: trunc(f.expected, 400), actual: trunc(f.actual, 400), proposedFix: f.proposedFix }
}

// ---------------------------------------------------------------- the plans (sequential, dependency-ordered)

// 001 first (folds cycles into verify → every later plan's gate also catches cycles);
// 002 before 005 (002 extracts the first module 005 builds on); 006 last (it gates the
// chat-history-switcher feature, built by the SEPARATE workflow). Each agent reads its
// plan file in full and follows the plan's OWN commit structure (1-3 commits).
const PLANS = [
  { id: '001', file: 'plans/001-verify-includes-cycles.md', title: 'fold npm run cycles into npm run verify',
    critical: 'package.json + ci.yml only. NO new tests (build-script change). The gate is that "npm run verify" now visibly runs madge ("✔ No circular dependency found!") before vitest. STOP if cycles already reports a cycle on the current tree.' },
  { id: '002', file: 'plans/002-extract-history-sanitizer.md', title: 'extract history-sanitizer helpers from api.ts',
    critical: 'PURE MOVE — byte-for-byte, no logic change. New module must NOT import from ./api.js (cycle). Re-export the public names from api.ts so tests/integration/agentic-chat.test.ts stays green; repoint tests/unit/history-sanitizer.test.ts. Cycles MUST stay 0.' },
  { id: '003', file: 'plans/003-isolate-post-commit-bookkeeping.md', title: 'isolate post-commit bookkeeping (try/catch) so a DB hiccup cannot drop a receipt',
    critical: 'TOUCH ONLY the post-commit TAIL of commitConfirmation. Everything ABOVE (confirmPending validation, policy re-check, markConfirmationUsed one-use claim, commitConfirmedOperation) is the safety boundary — byte-for-byte unchanged. Failing test FIRST (throwing bookkeeping must not 500; receipt returned; commit ran once). Catch logs MESSAGE ONLY.' },
  { id: '004', file: 'plans/004-signal-pagination-truncation.md', title: 'signal pagination truncation (paginateWithMeta + entries caveat)',
    critical: 'Part A: add paginateWithMeta, paginate delegates, warn once on truncation. Part B: thread truncated through getEntries port+adapter+fake+the entries action (list_truncated warning, mirror exportInvoice). Do NOT raise MAX_PAGES/PAGE_SIZE. The 7 other paginate callers stay unchanged. Two commits per the plan.' },
  { id: '005', file: 'plans/005-decompose-api-router.md', title: 'decompose api.ts — PHASE 1 ONLY (pure module extractions)',
    critical: 'PHASE 1 ONLY (request-schemas, consent-guard, async-handler). Do NOT attempt Phase 2 (the stateful route-group split). Each extraction is its own commit (3 commits), each a pure move with re-export shims, "npm run verify && npm run cycles" green before EACH commit. If any symbol turns out to close over deps state, leave it and STOP that sub-step.' },
  { id: '006', file: 'plans/006-graceful-history-restore.md', title: 'degrade quietly on a benign/failed chat-history restore',
    critical: 'UI-resilience only. historyRestoreItems shape-safe (undefined/{}/empty → []); restoreHistory degrades a NON-401 failure quietly (console.warn, no red alert) but KEEPS surfacing the 401/session-expired case; restoreGate.settle() must still run on every path. Do NOT touch the server route. Failing test FIRST.' },
]

function planPrompt(p, expectedHead) {
  return `Execute ONE plan from the plans/ backlog with strict TDD discipline.
${RULES}

PLAN ${p.id}: ${p.title}
Read ${REPO}/${p.file} IN FULL first — it has the exact Current-state excerpts, Steps, Scope (in/out), commit structure, Done criteria, and STOP conditions. Also skim ${REPO}/CLAUDE.md "Engineering rules" + "Safety & planner invariants".
Run the plan's own "Drift check" command FIRST; if the live code has drifted from the plan's excerpts, STOP (status="blocked", explain).
CRITICAL FOR THIS PLAN: ${p.critical}

PRECONDITIONS (check, else status="blocked" + preconditionFailed=true, do nothing else):
  cd ${REPO}; current branch === "main"; "git status --porcelain" empty; "git rev-parse --short HEAD" === ${expectedHead}.

PROTOCOL (follow the plan's Steps + its commit structure — most plans are ONE commit; 004 is TWO; 005 Phase 1 is THREE):
1. For each behavior-changing step: write the FAILING test FIRST, run only that file ("npx vitest run <path>"), confirm it fails for the stated reason (paste into notes). Plans that are pure config/move (001/002/005) need no new test — the existing suite + type-check + cycles are the guard.
2. GREEN: the minimal change from the plan. No drive-by edits, nothing outside the plan's Scope.
3. GATE before EACH commit: "npm run verify" (judge by EXIT CODE) AND "npx madge --circular --extensions ts --ts-config tsconfig.json src" (= 0 cycles).
4. Commit with the plan's suggested Conventional-Commit message(s). Update the plan's status row in plans/README.md (fold that into the plan's final commit). Never stage .env*, data/, eval-results/, dist/.

ABORTS: verify red twice after reasonable fixes → "git reset --hard ${expectedHead}", status="blocked". If a step would require touching the fenced safety boundary the plan marks Out-of-scope (the commit choke point above the post-commit tail, src/harness/* internals, raising a limit) → "git reset --hard ${expectedHead}", status="blocked_safety". If the plan's STOP conditions trigger → status="blocked" with the reason. NEVER weaken a safety boundary or a test to pass.

End with a CLEAN tree (treeClean=true). Report PLAN_SCHEMA: planId="${p.id}", finalCommitSha = the short sha of your LAST commit (HEAD), commitCount, testFiles, touchedPaths.`
}

// ---------------------------------------------------------------- the full live battery (the user's explicit choice)

const BATTERY_STEPS = [
  { key: 'live-sweep-pre', needs: ['live'], cmd: 'LIVE_CLOCKIFY=1 npx tsx --env-file=.env --env-file=.env.server scripts/live-sweep.ts',
    expect: 'Baseline sweep — should report 0 leftovers ("No AIASSIST_SMOKE_ leftovers found. Clean."). Pre-existing leftovers are a WARNING in summaryLine (a prior run or a colleague), not a finding for THIS run.' },
  { key: 'live-full', needs: ['live'], cmd: 'LIVE_CLOCKIFY=1 npx tsx --env-file=.env --env-file=.env.server scripts/live-full.ts',
    expect: 'Every catalog action vs live Clockify, self-cleaning. Summary like "PASS=… PREVIEW_OK=… UNSUPPORTED=… FAIL=… SKIP=…". Gate: FAIL=0. Each FAIL → one finding (dimension "live", severity high) quoting the action + error verbatim. 10-30 min — run in background and poll.' },
  { key: 'live-confirm-flow', needs: ['model'], cmd: 'npx tsx --env-file=.env.server scripts/live-confirm-flow.ts',
    expect: 'Confirm-safety battery over HTTP. Gate: PASS=16 FAIL=0. Any FAIL → finding (dimension "live", severity CRITICAL — these ARE the confirmation-safety invariants: nonce binding, one-use, TTL, policy re-check).' },
  { key: 'live-agentic-flow', needs: ['live', 'model'], cmd: 'LIVE_CLOCKIFY=1 npx tsx --env-file=.env --env-file=.env.server scripts/live-agentic-flow.ts',
    expect: 'Agentic loop vs the real host. Gate: PASS=10. Any FAIL → finding (severity high; CRITICAL if it shows a risky write committing without a confirmation).' },
  { key: 'eval-planner', needs: ['model'], cmd: 'npx tsx --env-file=.env.server scripts/eval-planner.ts --repeat=3',
    expect: 'Planner meter: "PLANNER EVAL: x/y (..%) | consistency ..%". Baseline 100% recently. pass < 96% OR a case failing all 3 repeats → one finding (dimension "eval", severity medium/high). Within noise = summaryLine only. Long run — background + poll.' },
  { key: 'live-chat-tour', needs: ['model'], cmd: 'npx tsx --env-file=.env.server scripts/live-chat-tour.ts',
    expect: 'Broad read-heavy dogfood tour, self-cleaning. Gate: completes with no FAIL/error lines. A wrong/untruthful answer = finding (high); cosmetic = low. Model flakiness the harness caught safely = note, not a finding.' },
  { key: 'live-sweep-post', needs: ['live'], cmd: 'LIVE_CLOCKIFY=1 npx tsx --env-file=.env --env-file=.env.server scripts/live-sweep.ts',
    expect: 'FINAL sweep — MUST report 0 leftovers. Any AIASSIST_SMOKE_/AIASSIST_LOOP_ leftover → finding (dimension "live", severity high): it means an action failed to self-clean.' },
]

function batteryPrompt(step) {
  return `You run ONE step of the full live battery against the SACRIFICIAL workspace only.
${RULES}

Step: ${step.key}
Command: cd ${REPO} && ${step.cmd}
Tee output to /tmp/ship-${step.key}.log and capture the script's real exit code (use PIPESTATUS or redirect-then-tail). Long runs (live-full, eval-planner): run_in_background and poll until it exits.

Expectations + findings policy:
${step.expect}

Exit-code contract: 0=pass, 1=fail, 2=environment missing. Exit 2 → status="skipped" with skipReason (do NOT invent findings for env problems). A colleague may share the sacrificial workspace — note suspected name-collision pollution in a finding's evidence so the refuter can weigh it.
Report BATTERY_SCHEMA: script="${step.key}", the verbatim summary marker line(s) in summaryLine, parsed numbers in metrics, ≤50-line verbatim failure excerpts inside each finding's evidence. For findings: reproCommand = the battery command; proposedFix.touchPaths = your best guess at the responsible source files (read the failing action's workflow/rest module to ground it).`
}

// ---------------------------------------------------------------- adversarial reviewers (scoped to the changes + the always-critical surfaces)

const REVIEW_DIMENSIONS = [
  { key: 'changes-review',
    brief: `Review THIS run's diff specifically: "git --no-pager diff ${'${BASE}'}..HEAD" where ${'${BASE}'} is the sha BELOW. The plans just landed: 001 (verify script), 002 (history-sanitizer extraction), 003 (post-commit try/catch), 004 (paginateWithMeta + entries truncation caveat), 005 Phase 1 (api.ts module extractions), 006 (graceful UI restore). For EACH changed hunk ask: did it preserve behavior where it claimed a pure move? did the try/catch in 003 leave the commit/one-use/policy-recheck path untouched? does 004's truncated flag thread correctly through port→adapter→fake→action without breaking the 7 untouched callers? did any extraction in 002/005 introduce a cycle or change a re-exported symbol's identity? Quote the exact lines. A behavior change hiding inside a "pure move/refactor" is a high-severity finding.` },
  { key: 'safety-invariants',
    brief: `Hunt regressions vs the pinned safety invariants (read CLAUDE.md "Safety & planner invariants" — every bullet is a contract; find a code path that EVADES it). Focus: src/routes/api.ts (truthful-preview replacement, TYPED_CONSENT guard, the commitConfirmation choke point that 003 touched), src/harness/confirmations.ts (one-use/TTL/nonce/policy re-check), src/harness/actions.ts (commitConfirmedOperation). Locate the test pinning each invariant you examine; a pinned invariant WITHOUT a pinning test is itself a finding (medium).` },
  { key: 'truthfulness',
    brief: `Preview/receipt honesty: does what the admin SEES always match what the commit DID? Check preview arg summaries vs actual payloads (src/harness/arg-summary.ts vs workflows/*), receipt fidelity + warnings (src/harness/receipts.ts — esp. 004's new list_truncated warning: does data.truncated + the warning both appear, and ONLY when truncated?), honest platform-restriction errors (src/clockify/rest/core.ts 401 mapping), and any place a success could print before/without the underlying write succeeding.` },
  { key: 'api-drift',
    brief: `Read CLAUDE.md "Clockify API facts" (live-verified, test-pinned). Re-verify a SAMPLE against the spec (https://docs.clockify.me/openapi.json) and flag spec/code disagreement — prioritizing the areas 004 touched (pagination params page/page-size; the time-entries envelope/route) plus the historically-wrong invoice ×100 discount/tax mapping and expense MAJOR units. IMPORTANT: a code/spec divergence PINNED by a unit test as live-verified (tests/unit/rest-*.test.ts) is deliberate — note it, not a finding. Severity high only when the shape matches neither spec nor any pinning test.` },
  { key: 'security',
    brief: `Secrets & security sweep: no token/secret can enter a ConfirmableOperation.payload (persisted to DB+audit; trace payload construction in workflows/* + actions.ts); no token/raw header in any log (grep console./logger across src/, check what each interpolates — esp. 003's new catch and 004's new warn); AES-256-GCM in src/db/store.ts (IV reuse? auth tag verified?); cookie flags in src/auth/; JWT RS256 verification in src/addon/ (alg confusion? unverified decode?); prepared statements everywhere; .gitignore covers .env*/data/*.sqlite and "git ls-files | grep -iE 'env|sqlite|token|secret'" is clean; the model never receives tokens/secrets (src/assistant/prompts.ts, agent-loop.ts).` },
  { key: 'test-gaps',
    brief: `Test-gap hunt in the SAFETY BOUNDARY and THIS run's new code first. Rank UNTESTED branches by blast radius: 003's post-commit catch (is the "bookkeeping throws → receipt still returned, commit ran once" path pinned, AND the happy path unchanged?), 004's paginateWithMeta truncated=true/false boundary + the entries caveat, 006's historyRestoreItems shape-safety + the 401-still-surfaces branch. Then broader: src/harness/undo.ts, compose.ts rollback-during-rollback, idempotency.ts window expiry, src/clockify/rest/core.ts error mapping (401/403/404/405/429/5xx/malformed JSON). For each: name the uncovered branch (file:line), why it matters, and the concrete test to add. The fix is the test (test: commit). Max 8, ranked.` },
]

function reviewPrompt(dim, baseSha) {
  return `You are the "${dim.key}" reviewer in an adversarial review of the AI Assistant add-on (TypeScript/Express/SQLite Clockify add-on; embedded admin chat + preview->confirm action harness).
${RULES}
${READ_ONLY}

The diff base for this run is HEAD's ancestor ${baseSha} (the commit before the plans landed). Where your brief references the diff, use it.

Your dimension:
${dim.brief.replace('${BASE}', baseSha)}

Contract for EVERY finding:
- file:line refs + QUOTED evidence (code or command output) — mandatory, no vibes.
- A repro command where one exists (a targeted vitest file, a tsx one-liner, a curl, a jq query).
- expected vs actual; a proposedFix (summary + a sketch of the failing test to write first + touchPaths).
- severity: critical=safety-invariant regression / data-loss / secret-leak; high=real product bug / wrong wire shape; medium=efficiency, misleading doc, missing safety-boundary test; low=dead code / cosmetic.
- Max 10 findings, ordered by severity. ZERO findings is a perfectly good answer if the dimension is clean — do NOT invent findings to look useful. Set dimension="${dim.key}" on each.`
}

function refuterPrompt(f, siblings) {
  return `You are an adversarial REFUTER. A reviewer (or a live battery step) claims the finding below. REFUTE it: reproduce it from a cold start and only CONFIRM if it survives your honest attempt to kill it.
${RULES}
${READ_ONLY}

FINDING ${f.id}:
${JSON.stringify(findingBrief(f), null, 2)}
${siblings.length ? `\nSiblings touching the same files (for duplicate detection — if this is substantially the same defect as an earlier sibling, status="duplicate" with duplicateOf):\n${JSON.stringify(siblings, null, 2)}` : ''}

Rules of evidence:
- Re-derive the claim INDEPENDENTLY — do not trust the reviewer's grep/summary. Counts/inventories by execution.
- "confirmed" REQUIRES you ran a repro (the reviewer's reproCommand or a better one) and pasted the observed output in reproOutput. No repro → downgrade to "unverifiable" with the reason.
- "refuted" REQUIRES quoting the code/output that disproves the claim (what the reviewer mis-read).
- "unverifiable" is honest (e.g. prod-only audit-host behavior, needs creds we don't have).
- api-drift: a code/spec divergence PINNED by a unit test as live-verified is deliberate → refuted.
- live-failure findings: weigh shared-sacrificial-workspace pollution and Clockify name-reservation quirks (names stay reserved after archive-then-delete) before confirming a product bug.
- You may adjust severity (severityFinal) with justification.
Report VERDICT_SCHEMA.`
}

function fixPrompt(f, expectedHead) {
  const sev = (f.verdict && f.verdict.severityFinal) || f.severity
  return `You implement ONE fix in the adversarial-review fix loop. TDD discipline per CLAUDE.md ("Engineering rules" + "Safety & planner invariants" — read them first).
${RULES}

CONFIRMED FINDING ${f.id} (${f.dimension}, severity ${sev}) — refuter-verified:
${JSON.stringify(findingBrief(f), null, 2)}
${f.verdict ? `Refuter notes: ${trunc(f.verdict.reasoning || '', 600)}${f.verdict.reproOutput ? `\nRepro output:\n${trunc(f.verdict.reproOutput, 1000)}` : ''}` : ''}

PRECONDITIONS: cd ${REPO}; branch "main"; "git status --porcelain" empty; HEAD === ${expectedHead}. If any fails → status="blocked", preconditionFailed=true, do nothing else.

PROTOCOL:
1. RED: write the failing test FIRST (test-gap findings: the test IS the fix). Run only that file; confirm it fails for the stated reason (paste into notes). If you cannot make it fail (not a real defect) → status="wont_fix", commit nothing.
2. GREEN: minimal fix, no drive-by refactors, nothing outside the finding's scope.
3. GATE: "npm run verify" (judge by EXIT CODE) AND "npx madge --circular --extensions ts --ts-config tsconfig.json src" = 0. Commit ONLY after both green.
4. ONE focused commit (fix(scope):/test:), repo log style. Never stage .env*, data/, eval-results/, dist/.
ABORTS: verify red twice → "git reset --hard ${expectedHead}", status="blocked". A SAFETY test fails (confirmations / truthful previews / typed consent / policy gate) → reset --hard, status="blocked_safety" — NEVER "fix" a safety test to pass. End with a clean tree.
Report FIX_SCHEMA: findingId="${f.id}", touchedPaths = files changed.`
}

async function pushMain(label) {
  const r = await agent(`Push main to origin (best-effort) and report.
${RULES}
Do: cd ${REPO}; confirm branch is "main" and "git status --porcelain" is empty; then "git push origin main 2>&1" and capture the result. Report JSON {pushed:boolean, headSha:"<short sha>", note:"<1-line: success, 'up to date', or the rejection reason verbatim>"}. If the push is REJECTED (auth / protected-branch status check), pushed=false and quote the reason — do NOT force-push, do NOT change git config; the local commits survive and a human can push. Never print secrets.`,
    { schema: { type: 'object', required: ['pushed', 'headSha'], properties: { pushed: { type: 'boolean' }, headSha: { type: 'string' }, note: { type: ['string', 'null'] } } }, label })
  return r || { pushed: false, headSha: '?', note: 'push agent died' }
}

// ================================================================ run

phase('Preflight')
const pre = await agent(`Preflight gate for the ship-plans-and-review run (plans land on MAIN; fixes commit to MAIN).
${RULES}
Checks, then report PREFLIGHT_SCHEMA:
1. Git: branch MUST be "main" and "git status --porcelain" MUST be empty (the plans/ + .claude/workflows/ artifacts should already be committed). If not → ok=false, abortReason explains (a dirty tree makes the HEAD-precondition + revert protocol unsafe).
2. Baseline verify: "npm run verify > /tmp/ship-baseline.log 2>&1; echo EXIT=$?" — verifyGreen=(EXIT==0); parse "Tests  N passed" → testCount. (600000ms timeout; background+poll if needed.) If red → ok=false, abortReason quotes the failure.
3. madgeCycles: "npx madge --circular --extensions ts --ts-config tsconfig.json src" → the count (0 expected).
4. Capabilities (PRESENCE ONLY, never print values): caps.live = LIVE_CLOCKIFY_API_KEY + LIVE_WORKSPACE_ID present in .env, AND the LIVE_WORKSPACE_ID value equals ${WORKSPACE_ID} (compare with a shell test WITHOUT printing it; if it differs set caps.live=false + caps.wsMatches=false + a warning — live tests must ONLY hit the sacrificial workspace). caps.model = LLM_API_KEY present in .env.server (or LLM_PROVIDER=gemini-cli). Record every missing capability as a warning.
5. headSha = "git rev-parse --short HEAD".
ok=true ONLY when on main, clean tree, verify green, madge 0. Missing capabilities are warnings (degradation), not failures.`,
  { schema: PREFLIGHT_SCHEMA, label: 'preflight' })

if (!pre || !pre.ok) {
  return { aborted: true, reason: 'preflight failed (need clean main + green verify)', pre }
}
const baseSha = pre.headSha // diff base for the review phase
let headSha = pre.headSha
const caps = pre.caps || { live: false, model: false }
log(`Preflight ok @ ${headSha} · tests=${pre.testCount} · cycles=${pre.madgeCycles} · live=${caps.live} model=${caps.model}${(pre.warnings || []).length ? ' · WARN: ' + pre.warnings.join('; ') : ''}`)

// ---- Plans: sequential TDD, one focused commit-set per plan, HEAD-gated ----
phase('Plans')
const planResults = []
let halted = null
let consecutiveBlocked = 0
for (const p of PLANS) {
  if (halted) { planResults.push({ planId: p.id, status: 'skipped', attempts: 0, treeClean: true, notes: 'halted: ' + halted }); continue }
  const r = await agent(planPrompt(p, headSha), { schema: PLAN_SCHEMA, phase: 'Plans', label: `plan:${p.id}` })
  if (!r) { planResults.push({ planId: p.id, status: 'blocked', attempts: 0, treeClean: true, notes: 'agent died' }); consecutiveBlocked++ }
  else {
    planResults.push(r)
    if (r.preconditionFailed) { halted = `precondition at ${p.id} (${trunc(r.notes || '', 160)})`; continue }
    if (r.status === 'blocked_safety') { halted = `SCOPE FENCE / safety at ${p.id} — ${trunc(r.notes || '', 200)}`; continue }
    if (r.status === 'done' && r.finalCommitSha) { headSha = r.finalCommitSha.slice(0, 9); consecutiveBlocked = 0 }
    else consecutiveBlocked++
    log(`plan ${p.id}: ${r.status}${r.finalCommitSha ? ' @ ' + r.finalCommitSha.slice(0, 7) + ` (${r.commitCount || 1} commit${(r.commitCount || 1) > 1 ? 's' : ''})` : ''}`)
  }
  if (consecutiveBlocked >= 2 && !halted) halted = 'two consecutive blocked plans'
}
const plansLanded = planResults.filter((r) => r.status === 'done' && r.finalCommitSha)
log(`Plans: ${plansLanded.length}/${PLANS.length} landed${halted ? ` — HALTED: ${halted}` : ''}`)
const pushAfterPlans = plansLanded.length ? await pushMain('push:plans') : { pushed: false, headSha, note: 'no plans landed' }
log(`push after plans: ${pushAfterPlans.pushed ? 'OK @ ' + pushAfterPlans.headSha : 'NOT pushed (' + (pushAfterPlans.note || '') + ')'}`)

// ---- Evidence: full live battery (sequential) in parallel with the reviewers ----
phase('Evidence')
function batteryRunnable(step) {
  const missing = (step.needs || []).filter((n) => !caps[n])
  if (missing.length) { log(`battery ${step.key}: SKIP (missing ${missing.join('+')})`); return null }
  return step
}
const batteryThunk = async () => {
  const out = []
  for (const step of BATTERY_STEPS) {
    const ok = batteryRunnable(step)
    if (!ok) { out.push({ script: step.key, status: 'skipped', exitCode: null, summaryLine: '', skipReason: 'capability missing', metrics: null, findings: [] }); continue }
    const r = await agent(batteryPrompt(step), { schema: BATTERY_SCHEMA, phase: 'Battery', label: `battery:${step.key}` })
    out.push(r || { script: step.key, status: 'fail', exitCode: null, summaryLine: 'battery agent died', skipReason: null, metrics: null, findings: [] })
    log(`battery ${step.key}: ${(r && r.status) || 'fail'}${r && r.summaryLine ? ' — ' + trunc(r.summaryLine, 90) : ''}`)
  }
  return out
}
const reviewsThunk = () => parallel(REVIEW_DIMENSIONS.map((d) => () =>
  agent(reviewPrompt(d, baseSha), { schema: FINDINGS_SCHEMA, phase: 'Reviews', label: `review:${d.key}` })))

const [batteryResults, reviewResults] = await parallel([batteryThunk, reviewsThunk])

// ---- Merge findings (script-side id assignment + exact dedupe by file+title) ----
const raw = []
for (const r of (reviewResults || []).filter(Boolean)) raw.push(...(r.findings || []))
for (const b of (batteryResults || []).filter(Boolean)) raw.push(...(b.findings || []))
const seenKey = new Set()
const findings = []
for (const f of raw) {
  const key = `${(f.files && f.files[0] && f.files[0].path) || f.dimension}::${slug(f.title)}`
  if (seenKey.has(key)) continue
  seenKey.add(key)
  f.id = `F${findings.length + 1}-${f.dimension}-${slug(f.title).slice(0, 28)}`
  findings.push(f)
}
const liveFail = (batteryResults || []).filter(Boolean).some((b) => b.status === 'fail')
log(`Evidence: ${findings.length} findings (${raw.length} raw) · live battery ${liveFail ? 'has FAILures' : 'clean/skipped'}`)

// ---- Verify findings: one adversarial refuter each ----
phase('Verify findings')
let confirmed = []
if (findings.length) {
  const verdicts = await parallel(findings.map((f) => () => {
    const siblings = findings.filter((s) => s.id !== f.id && s.files && f.files && s.files[0] && f.files[0] && s.files[0].path === f.files[0].path).map((s) => ({ id: s.id, title: s.title }))
    return agent(refuterPrompt(f, siblings), { schema: VERDICT_SCHEMA, phase: 'Verify findings', label: `refute:${f.id}` }).then((v) => ({ ...f, verdict: v }))
  }))
  const judged = verdicts.filter(Boolean)
  confirmed = judged.filter((f) => f.verdict && f.verdict.status === 'confirmed')
  const refuted = judged.filter((f) => f.verdict && f.verdict.status === 'refuted').length
  const unver = judged.filter((f) => f.verdict && f.verdict.status === 'unverifiable').length
  const dup = judged.filter((f) => f.verdict && f.verdict.status === 'duplicate').length
  log(`Verdicts: ${confirmed.length} confirmed / ${refuted} refuted / ${unver} unverifiable / ${dup} duplicate`)
}

// ---- Fix: strictly sequential TDD, one commit each, HEAD-gated ----
phase('Fix')
const SEV = { critical: 0, high: 1, medium: 2, low: 3 }
const queue = [...confirmed].sort((a, b) => (SEV[(a.verdict && a.verdict.severityFinal) || a.severity] ?? 9) - (SEV[(b.verdict && b.verdict.severityFinal) || b.severity] ?? 9))
const fixResults = []
let fixHalted = null
let fixBlocked = 0
for (const f of queue) {
  if (fixHalted) { fixResults.push({ findingId: f.id, status: 'blocked', attempts: 0, treeClean: true, notes: 'halted: ' + fixHalted }); continue }
  const r = await agent(fixPrompt(f, headSha), { schema: FIX_SCHEMA, phase: 'Fix', label: `fix:${f.id}` })
  if (!r) { fixResults.push({ findingId: f.id, status: 'blocked', attempts: 0, treeClean: true, notes: 'agent died' }); fixBlocked++ }
  else {
    fixResults.push(r)
    if (r.preconditionFailed) { fixHalted = `precondition at ${f.id}`; continue }
    if (r.status === 'blocked_safety') { fixHalted = `SAFETY test failed at ${f.id}`; continue }
    if (r.status === 'fixed' && r.commitSha) { headSha = r.commitSha.slice(0, 9); fixBlocked = 0 }
    else if (r.status === 'blocked') fixBlocked++
    else fixBlocked = 0
    log(`fix ${f.id}: ${r.status}${r.commitSha ? ' @ ' + r.commitSha.slice(0, 7) : ''}`)
  }
  if (fixBlocked >= 2 && !fixHalted) fixHalted = 'two consecutive blocked fixes'
}
const fixesLanded = fixResults.filter((r) => r.status === 'fixed' && r.commitSha)

// ---- Push: final gate + push main ----
phase('Push')
const gate = await agent(`Final gate for the ship-plans-and-review run, then push main.
${RULES}
Run, judging by exit codes, and report GATE_SCHEMA:
1. cd ${REPO} && npm run verify > /tmp/ship-final.log 2>&1; echo EXIT=$? — pass=(EXIT==0); parse "Tests  N passed" → testCount.
2. npx madge --circular --extensions ts --ts-config tsconfig.json src → madgeCycles (expect 0).
3. headSha = git rev-parse --short HEAD; confirm "git status --porcelain" is empty.
4. ONLY IF pass && madgeCycles===0 && clean tree: "git push origin main 2>&1" → pushed + pushNote (quote a rejection verbatim; do NOT force-push or change git config). If the gate is RED, do NOT push: pushed=false, pushNote="gate red — not pushed", paste the failure in failures.
Never print secrets.`,
  { schema: GATE_SCHEMA, label: 'final-gate-push' })

phase('Report')
return {
  startSha: pre.headSha,
  endSha: (gate && gate.headSha) || headSha,
  plans: planResults.map((r) => ({ planId: r.planId, status: r.status, finalCommitSha: r.finalCommitSha || null, commitCount: r.commitCount || null, notes: trunc(r.notes || '', 200) })),
  plansLanded: plansLanded.length,
  plansHalted: halted,
  pushAfterPlans: { pushed: pushAfterPlans.pushed, note: pushAfterPlans.note || null },
  battery: (batteryResults || []).filter(Boolean).map((b) => ({ script: b.script, status: b.status, summaryLine: trunc(b.summaryLine || '', 160), findings: (b.findings || []).length })),
  findingsRaw: findings.length,
  confirmed: confirmed.map((f) => ({ id: f.id, dimension: f.dimension, title: f.title, severity: (f.verdict && f.verdict.severityFinal) || f.severity })),
  fixes: fixResults.map((r) => ({ findingId: r.findingId, status: r.status, commitSha: r.commitSha || null, testFile: r.testFile || null, notes: trunc(r.notes || '', 200) })),
  fixesLanded: fixesLanded.length,
  fixHalted,
  finalGate: gate ? { pass: gate.pass, testCount: gate.testCount, madgeCycles: gate.madgeCycles, pushed: gate.pushed, pushNote: gate.pushNote || null, failures: trunc(gate.failures || '', 800) } : null,
  pushedMain: !!(gate && gate.pushed),
  outcome: (gate && gate.pass && gate.madgeCycles === 0)
    ? (gate.pushed ? 'GREEN — plans + review fixes on main, pushed' : 'GREEN locally — gate passed but push did not land (see pushNote); commits are safe, push manually')
    : 'NEEDS ATTENTION — final gate not clean; commits are individually green but review the failures',
  nextStep: halted || fixHalted
    ? 'Build halted — inspect main, resolve, and re-run this workflow (landed plans/fixes are committed and skip via their HEAD precondition).'
    : 'Plans + review done on main. Now run the implement-chat-history-switcher workflow to build the feature (it depends on plan 006, now landed).',
}
