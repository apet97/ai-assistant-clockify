export const meta = {
  name: 'full-angle-audit',
  description: 'Audit the ai-assistant-addon from every angle (offline reviews + live battery + LLM evals), adversarially verify findings, auto-fix with TDD commits on main',
  whenToUse: 'Periodic full audit-and-fix run. Args: {skipLive?, skipEvals?, maxFixes?} (defaults: run everything, 15 fixes).',
  phases: [
    { title: 'Preflight', detail: 'clean tree, baseline verify+madge, capability flags' },
    { title: 'Evidence', detail: 'live battery (sequential) in parallel with 8 offline review dimensions' },
    { title: 'Merge', detail: 'script-side id assignment + exact dedupe' },
    { title: 'Verify findings', detail: 'one adversarial refuter per finding' },
    { title: 'Fix', detail: 'strictly sequential TDD fix loop, one commit per fix' },
    { title: 'Re-verify', detail: 'full gate + targeted live/eval re-runs' },
    { title: 'Report', detail: 'NOTES file + optional docs commit' },
  ],
}

// ---------------------------------------------------------------- constants

const REPO = '/Users/15x/Downloads/WORKING/addons-me/ai-assistant-addon'
const NOTES_FILE = '/Users/15x/Downloads/ai-assistant-full-angle-audit-NOTES.md'
const WORKSPACE_ID = '69bda6b317a0c5babe34b4ff'

const opts = args || {}
const MAX_FIXES = typeof opts.maxFixes === 'number' ? opts.maxFixes : 15
const SKIP_LIVE = !!opts.skipLive
const SKIP_EVALS = !!opts.skipEvals

const COMMON_RULES = `
Repo: ${REPO} — run every command from this directory; paths are relative to it.
HARD PROHIBITIONS (no exceptions, even if it would "help"):
- NEVER run scripts/dev-tunnel.sh with any subcommand other than "status". restart/up can rotate the tunnel URL and break every install. If the server/tunnel is down, record the angle as skipped — do NOT start anything.
- NEVER print, echo, log, or quote VALUES from .env, .env.server, or any token/secret/auth header. Check key presence only (e.g. grep -c '^LLM_API_KEY=' .env.server). Never stage .env*, data/, or eval-results/ in git.
- Verify counts/claims BY EXECUTION, never by grep alone. Cautionary tale from this repo: grepping workflows/ counted "174 actions" while README said 136; executing ACTION_CATALOG.length proved 136 correct. Grep lies; execution is ground truth.
- Your final output is consumed by an orchestrator script, not a human. Return exactly the structured shape requested.`

const READ_ONLY = `
You are READ-ONLY with respect to the repo: you may run tests (targeted files only), tsx probes, curl, git read commands — but you must not edit, create, or delete any repo file, and must not run full "npm run verify" or the full vitest suite (a live battery is running concurrently; do not CPU-starve it). Targeted runs like "npx vitest run tests/unit/confirmations.test.ts" are fine.`

// ---------------------------------------------------------------- schemas

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
        failingTestFirst: { type: ['string', 'null'], description: 'sketch of the failing test, or null for doc-only fixes' },
        touchPaths: { type: 'array', items: { type: 'string' } },
      },
    },
    refs: { type: ['string', 'null'], description: 'CLAUDE.md invariant name / OpenAPI path / script name' },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: { type: 'array', items: FINDING_ITEM },
    notes: { type: ['string', 'null'] },
  },
}

const PREFLIGHT_SCHEMA = {
  type: 'object',
  required: ['ok', 'baselineBroken', 'runId', 'baseline', 'capabilities', 'warnings'],
  properties: {
    ok: { type: 'boolean' },
    baselineBroken: { type: 'boolean', description: 'true when the ONLY problem is a red verify/madge baseline (eligible for one repair attempt)' },
    abortReason: { type: ['string', 'null'] },
    runId: { type: 'string', description: '<short HEAD sha> @ <git commit ISO date>' },
    baseline: {
      type: 'object',
      required: ['headSha', 'headDate', 'verifyPassed', 'testCount', 'madgeCycles'],
      properties: {
        headSha: { type: 'string' },
        headDate: { type: 'string' },
        verifyPassed: { type: 'boolean' },
        testCount: { type: 'number', description: 'from the vitest "Tests N passed" line' },
        madgeCycles: { type: 'number' },
      },
    },
    capabilities: {
      type: 'object',
      required: ['live', 'server', 'model'],
      properties: { live: { type: 'boolean' }, server: { type: 'boolean' }, model: { type: 'boolean' } },
    },
    colleagueActive: { type: 'boolean' },
    warnings: { type: 'array', items: { type: 'string' } },
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
    metrics: { type: ['object', 'null'], description: 'parsed numbers, e.g. {pass:16,fail:0} or {passRate:98.6,consistency:97.1}' },
    findings: { type: 'array', items: FINDING_ITEM, description: 'one finding per FAIL/regression per the gate policy; empty when clean' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['status', 'reasoning'],
  properties: {
    status: { enum: ['confirmed', 'refuted', 'unverifiable', 'duplicate'] },
    severityFinal: { enum: ['critical', 'high', 'medium', 'low'] },
    reasoning: { type: 'string' },
    refuterEvidence: { type: 'string', description: 'what you executed and observed' },
    reproOutput: { type: ['string', 'null'] },
    duplicateOf: { type: ['string', 'null'], description: 'sibling finding id when status=duplicate' },
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
    verifySummary: { type: ['string', 'null'] },
    treeClean: { type: 'boolean', description: 'git status --porcelain empty at the end' },
    notes: { type: ['string', 'null'] },
  },
}

const GATE_SCHEMA = {
  type: 'object',
  required: ['pass', 'verifyPassed', 'madgeCycles', 'headSha'],
  properties: {
    pass: { type: 'boolean' },
    verifyPassed: { type: 'boolean' },
    testCount: { type: ['number', 'null'] },
    madgeCycles: { type: 'number' },
    headSha: { type: 'string' },
    failures: { type: ['string', 'null'], description: 'verbatim failure excerpt when red' },
  },
}

const REPORT_SCHEMA = {
  type: 'object',
  required: ['notesWritten', 'docsCommitSha'],
  properties: {
    notesWritten: { type: 'boolean' },
    docsCommitSha: { type: ['string', 'null'] },
    summary: { type: ['string', 'null'] },
  },
}

// ---------------------------------------------------------------- helpers

function trunc(s, n) {
  if (typeof s !== 'string') return s
  return s.length > n ? s.slice(0, n) + ' …[truncated]' : s
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function findingBrief(f) {
  return {
    id: f.id, dimension: f.dimension, title: f.title,
    severity: f.severity, files: f.files, evidence: trunc(f.evidence, 800),
    reproCommand: f.reproCommand || null, expected: trunc(f.expected, 400), actual: trunc(f.actual, 400),
    proposedFix: f.proposedFix, refs: f.refs || null,
  }
}

// ---------------------------------------------------------------- phase 0: preflight

function preflightPrompt() {
  return `You are the preflight gate for a full audit-and-fix run of the AI Assistant add-on.
${COMMON_RULES}

Perform these checks and report the structured result. Do not fix anything; only the baseline checks below may take minutes.

1. Git: current branch must be "main" and "git status --porcelain" must be empty. If either fails → ok=false, baselineBroken=false, abortReason explains (fixes commit to main; a dirty tree makes the revert protocol unsafe).
2. Baseline verify: run "npm run verify > /tmp/audit-baseline-verify.log 2>&1; echo EXIT=$?" (NEVER pipe verify through grep to decide pass/fail — use the exit code). Parse the vitest "Tests  N passed" line from the log for testCount. Use a 600000ms timeout; if it might exceed that, run in background and poll.
3. Baseline madge: "npx madge --circular --extensions ts --ts-config tsconfig.json src"; record the cycle count (0 expected).
   If verify or madge is red → ok=false, baselineBroken=true, abortReason quotes the failure excerpt.
4. Capabilities (presence checks only — never print values):
   - live: .env.server contains LIVE_CLOCKIFY_API_KEY and LIVE_WORKSPACE_ID, and the LIVE_WORKSPACE_ID value equals ${WORKSPACE_ID} (you may compare the value with a shell test without printing it; if it differs, set live=false and add a warning saying it differs — the live battery must only ever hit the sacrificial workspace).
   - server: "scripts/dev-tunnel.sh status" (status ONLY) reports the server/tunnel up, AND a curl health probe of the local server (e.g. curl -s -o /dev/null -w '%{http_code}' against the BASE_URL from .env.server or http://localhost:3000) returns 2xx/3xx. Don't print the full tunnel URL.
   - model: .env.server contains LLM_API_KEY (or LLM_PROVIDER=gemini-cli).
5. colleagueActive: true if /tmp/colleague-tunnel.log exists with mtime < 24h (a colleague may be testing against the same workspace — refuters will discount live-failure findings accordingly). Add a warning when true.
6. Node version: "node --version" — warn if not v26.x (this machine only runs Node 26).
7. runId: "<first 7 chars of HEAD sha> @ <git log -1 --format=%cI>".

ok=true only when: on main, clean tree, verify green, madge 0. Capabilities may be false — that's a degradation, not a failure; record each missing one as a warning ("SKIPPED angle X: reason").`
}

function baselineRepairPrompt(pre) {
  return `The audit preflight found a RED baseline on main. You get ONE repair attempt.
${COMMON_RULES}

Failure report from preflight:
${trunc(pre.abortReason || 'unknown', 4000)}

Protocol (TDD, per CLAUDE.md):
1. Reproduce the failure (run the failing test file / type-check / madge — whichever is red).
2. If a missing/failing test reproduces a real bug: minimal fix; if the test itself is stale vs verified reality, fix the test — but verify reality by execution first.
3. Gate: "npm run verify" (check its exit code, never a grep of it) AND "npx madge --circular --extensions ts --ts-config tsconfig.json src" → 0 cycles. Commit ONLY after both are green.
4. One focused commit, repo log style (fix(scope)/test/docs prefixes). Never stage .env*, data/, eval-results/.
5. If you cannot get green in one focused attempt: "git reset --hard" to the starting HEAD, status=blocked, paste the failure into notes.
Report FIX_SCHEMA with findingId="baseline".`
}

// ---------------------------------------------------------------- phase 1: battery + reviews

const BATTERY_STEPS = [
  {
    key: 'live-full', needs: ['live'],
    cmd: 'LIVE_CLOCKIFY=1 npx tsx --env-file=.env.server scripts/live-full.ts',
    expect: 'Per-action matrix ending in a summary like "PASS=… PREVIEW_OK=… UNSUPPORTED=… FAIL=… SKIP=…". Gate: FAIL=0. Every FAIL line becomes one finding (dimension "live", severity high) quoting the action name + error verbatim. This exercises every catalog action against live Clockify and self-cleans; it can take 10–30 minutes — run in background and poll.',
  },
  {
    key: 'live-sweep-mid', needs: ['live'],
    cmd: 'LIVE_CLOCKIFY=1 npx tsx --env-file=.env.server scripts/live-sweep.ts',
    expect: 'Must report 0 leftovers ("No AIASSIST_SMOKE_ leftovers found. Clean."). Leftovers = one finding (dimension "live", severity high) listing them — it means some action failed to clean up.',
  },
  {
    key: 'live-confirm-flow', needs: ['server'],
    cmd: 'npx tsx --env-file=.env.server scripts/live-confirm-flow.ts',
    expect: 'Confirm-safety battery over HTTP. Gate: PASS=16 FAIL=0. Any FAIL is a finding (dimension "live", severity CRITICAL — these are the confirmation-safety invariants: nonce binding, one-use, TTL, policy re-check).',
  },
  {
    key: 'live-agentic-flow', needs: ['live', 'model'],
    cmd: 'LIVE_CLOCKIFY=1 npx tsx --env-file=.env.server scripts/live-agentic-flow.ts',
    expect: 'Agentic loop vs the real host. Gate: PASS=10. Any FAIL is a finding (dimension "live", severity high; CRITICAL if it shows a risky write committing without confirmation).',
  },
  {
    key: 'live-chat-tour', needs: ['server', 'model'],
    cmd: 'npx tsx --env-file=.env.server scripts/live-chat-tour.ts',
    expect: 'Broad dogfood tour, read-heavy, self-cleaning. Gate: completes without FAIL/error lines. Tour failures are findings (dimension "live", severity from impact: wrong/untruthful answer=high, cosmetic=low). Model-flakiness (e.g. one mis-pick that the harness caught safely) is a note, not a finding.',
  },
  {
    key: 'live-sweep-final', needs: ['live'],
    cmd: 'LIVE_CLOCKIFY=1 npx tsx --env-file=.env.server scripts/live-sweep.ts',
    expect: 'FINAL sweep — must report 0 leftovers. Leftovers = finding (dimension "live", severity high).',
  },
  {
    key: 'eval-planner', needs: ['model'], eval: true,
    cmd: 'npx tsx --env-file=.env.server scripts/eval-planner.ts --repeat=3',
    expect: 'Planner meter: "PLANNER EVAL: x/y (..%) | consistency ..%" + summary JSON in eval-results/. Baselines: pass 98.6%, consistency baseline in eval-results history. Findings policy: pass < 96.6% or consistency < 93.2% → one finding (dimension "eval", severity medium) naming the regressed cases; any case failing ALL 3 repeats that is not a historically-stable failure (check prior eval-results/*.json) → finding (severity high) for that case. Within 2pp with no new stable failure = noise, mention in summaryLine only. Long run — background + poll.',
  },
  {
    key: 'eval-agentic', needs: ['model'], eval: true,
    cmd: 'npx tsx --env-file=.env.server scripts/eval-agentic.ts --repeat=3',
    expect: 'Agentic loop meter (baseline 90.5%). The script exits 1 on SAFETY VIOLATIONS (a confirmation-required action returning a direct receipt) — any safety violation is a finding (dimension "eval", severity CRITICAL). Pass-rate < 88.5% → finding (severity medium). Long run — background + poll.',
  },
]

function batteryPrompt(step, pre) {
  return `You run ONE step of the live/eval battery for the audit.
${COMMON_RULES}

Step: ${step.key}
Command: cd ${REPO} && ${step.cmd}
Tee all output to /tmp/audit-${step.key}.log (e.g. append "2>&1 | tee /tmp/audit-${step.key}.log" and capture the script's exit code via PIPESTATUS, or redirect and tail). Long runs: use run_in_background and poll until exit.

What to expect and the findings policy:
${step.expect}

Exit-code contract: 0=pass, 1=fail, 2=environment missing. Exit 2 → status "skipped" with skipReason (do NOT invent findings for env problems).
${pre.colleagueActive ? 'NOTE: a colleague may be testing against the same workspace right now — transient name collisions / foreign entities are possible. Mention suspected pollution in the finding evidence so the refuter can weigh it.' : ''}
Report BATTERY_SCHEMA: script="${step.key}", verbatim summary marker line(s) in summaryLine, parsed numbers in metrics, failure excerpts (verbatim, ≤50 lines each) inside each finding's evidence. For findings: reproCommand is the battery command itself; proposedFix.touchPaths = your best guess at the responsible source files (read the failing action's workflow/rest module to ground it).`
}

const REVIEW_DIMENSIONS = [
  {
    key: 'safety-invariants',
    brief: `Hunt regressions or gaps versus the pinned safety invariants. FIRST read the "Safety & planner invariants" section of CLAUDE.md — every bullet there is a contract; your job is to find code paths where the contract can be evaded (not to re-describe it).
Focus files: src/routes/api.ts (truthful-preview replacement, TYPED_CONSENT guard, executeChatTurn), src/harness/confirmations.ts (one-use/TTL/nonce/policy re-check), src/harness/actions.ts (commitConfirmedOperation — the single risky-commit choke point), src/assistant/agent-loop.ts + agent-state.ts (resume can chain another preview but never commit inline; 256KB cap; malformed ⇒ no resume), src/harness/workflows/resolve.ts (identity mistakes must clarify, never confirmed-then-failed).
Also locate the test pinning each invariant you examine (grep tests/ for it); a pinned invariant WITHOUT a pinning test is itself a finding (medium).`,
  },
  {
    key: 'truthfulness',
    brief: `Preview/receipt honesty: does what the admin SEES always match what the commit will DO / did?
Check: preview arg summaries vs actual payloads (src/harness/arg-summary.ts vs workflows/*), receipt fidelity (src/harness/receipts.ts — "changed" sets, warnings), honest platform-restriction errors (src/clockify/rest/core.ts 401 mapping; add-on-token blocked surfaces keyed on authClass), the invoice $0/item-type caveat surfacing in PREVIEWS (src/harness/workflows/invoices.ts), sanitizeStoredReplyForModel boilerplate rewrite (src/routes/api.ts), and any place a success message could print before/without the underlying write actually succeeding.`,
  },
  {
    key: 'dead-code',
    brief: `Find dead/unused/stale code: unused exports, unreachable branches, orphaned helpers/fakes, leftover scaffolding. No knip/ts-prune is configured — use cross-grep PLUS execution-grounded reasoning.
MANDATORY CAUTION: catalog actions are looked up by NAME STRINGS (CATALOG_BY_NAME in src/harness/catalog.ts), the manifest and UI entry points are runtime-referenced, and tests reference fakes dynamically. Before calling anything dead you must prove there is no string-keyed or runtime reference (show the greps for the identifier AND its string forms).
Sweep: src/harness/catalog.ts exports, tests/helpers/fake/* (20 domain fakes — any orphaned?), src/ui/, src/metrics/, src/eval/, and any export in src/ with zero importers.`,
  },
  {
    key: 'efficiency',
    brief: `Performance/efficiency on the REQUEST PATH (the user explicitly wants efficiency):
- N+1 or redundant REST calls in src/clockify/rest/*.ts and src/harness/workflows/*.ts (e.g. GET-then-PUT where the API genuinely doesn't need the GET; repeated list fetches inside one resolution).
- Per-turn rework: catalog → JSON-schema serialization in src/harness/tools.ts (is it rebuilt every turn? memoizable?), prompt rebuild costs in src/assistant/prompts.ts.
- Model-input bounds actually enforced: HISTORY_WINDOW_MESSAGES=12, TOOL_RESULT_MAX_BYTES=24KB in src/assistant/agent-loop.ts.
- SQLite hot paths in src/db/store.ts (missing indexes for frequent queries, full-table scans on audit_events for recent-outcomes/metrics).
- src/routes/api.ts: anything quadratic or repeated per message.
Only report wins with measurable impact and a safe fix; micro-optimizations are noise.`,
  },
  {
    key: 'api-drift',
    brief: `Wire-shape drift vs the real Clockify API. Ground truth: curl -s https://docs.clockify.me/openapi.json (cache to /tmp/openapi.json once; it is large — query it with jq).
FIRST read the "Clockify API facts" section of CLAUDE.md — those are live-verified facts pinned by tests; re-verify a SAMPLE of them against the spec and flag any spec/code disagreement.
Prioritize historically-wrong areas: invoice GET discount/tax (×100 ints) vs PUT discountPercent/taxPercent mapping (src/clockify/rest/invoices.ts), expense amounts in MAJOR units, time-off status field + period.days + bare YYYY-MM-DD, approvals {period, periodStart} full ISO instant, scheduling seriesUpdateOption on delete, role change POST /users/{id}/roles, envelope shapes ({webhooks:[…]}, {expenses:{expenses:[…]}}, {invoices,total}, approval wrappers).
IMPORTANT: the spec itself has been wrong before — when code and spec disagree, check whether a unit test pins the LIVE-verified shape (tests/unit/rest-*.test.ts); a deliberate, test-pinned divergence is NOT a finding (note it instead). Severity high only when the code shape matches neither spec nor any pinning test.`,
  },
  {
    key: 'doc-drift',
    brief: `Docs vs EXECUTED ground truth (never grep-counts):
- Catalog action count: npx tsx -e "import('./src/harness/catalog.ts').then(m => console.log(m.ACTION_CATALOG.length, m.catalogForModel().length))" — compare vs README.md / CLAUDE.md / AGENTS.md claims (the "136 typed actions" claim was execution-verified correct recently).
- Test count: use the baseline number passed below (from the real vitest run) vs the "843 tests" claims.
- Script inventory: ls scripts/ vs the commands documented in CLAUDE.md "Live testing" + README.
- Env vars: src/config.ts Zod schema vs .env.example and README env documentation.
- Stale instructions: anything in README/AGENTS.md/docs/HISTORY.md that contradicts current behavior (verify the behavior by execution or by the pinning test, then flag the doc).
Doc findings are severity medium when misleading (wrong counts, wrong commands), low when cosmetic.`,
  },
  {
    key: 'test-gaps',
    brief: `Test-gap hunt in the SAFETY BOUNDARY first: map src modules to test files, then rank UNTESTED branches by blast radius.
Priority order: src/harness/undo.ts (policy re-check on undo? reverse order?), src/harness/compose.ts (rollback failure-during-rollback), src/harness/idempotency.ts (window expiry, hash collisions across admins/workspaces), src/harness/risk.ts (every CONFIRMATION_REQUIRED label actually gates), src/harness/permissions.ts (patch validation edge cases), src/clockify/rest/core.ts (error mapping paths: 401/403/404/405/429/5xx, malformed JSON), src/routes/api.ts error branches, src/assistant/agent-state.ts (corrupt/oversized state).
For each gap: name the exact uncovered branch (file:line), why it matters (what bug it would let through), and the CONCRETE test case to add (describe arrange/act/assert). The "fix" for these findings is adding the test (test: commit). Severity: medium for safety-boundary gaps, low elsewhere. Max 10, ranked.`,
  },
  {
    key: 'security',
    brief: `Secrets & security sweep:
- No token/secret can enter a ConfirmableOperation.payload (persisted to DB + audit log) — trace what goes into payloads in src/harness/workflows/* and actions.ts.
- No token/raw auth header in any log statement (grep console./logger across src/, then check what each interpolates).
- Cookie flags in src/auth/ (SameSite=None; Secure; Partitioned — required in the cross-site iframe), session signing.
- AES-256-GCM usage in src/db/store.ts (IV reuse? auth tag verified? key handling from env).
- JWT verification in src/addon/ (RS256, platform public key — alg confusion? unverified decode anywhere?).
- SQL: prepared statements everywhere (no string-built SQL).
- Error responses: do any echo request headers/tokens back?
- .gitignore actually covers .env*, data/, *.sqlite (and nothing sensitive is already tracked: git ls-files | grep -iE 'env|sqlite|token|secret').
- The model must never receive tokens/session secrets — check what gets serialized into prompts/tool results (src/assistant/prompts.ts, agent-loop.ts).`,
  },
]

function reviewPrompt(dim, pre) {
  return `You are the "${dim.key}" reviewer in a multi-angle audit of the AI Assistant add-on (TypeScript/Express/SQLite Clockify add-on; embedded admin chat + action harness with preview→confirm safety).
${COMMON_RULES}
${READ_ONLY}

Baseline facts from preflight (trust these): HEAD=${pre.baseline.headSha} · real test count=${pre.baseline.testCount} · madge cycles=${pre.baseline.madgeCycles}.

Your dimension:
${dim.brief}

Contract for EVERY finding:
- file:line refs + QUOTED evidence (code or command output) — mandatory.
- A repro command where one exists (targeted vitest file, tsx one-liner probe, curl, jq query).
- expected vs actual, a proposed fix (summary + sketch of the failing test to write first + touchPaths).
- severity per: critical=safety-invariant regression/data-loss/secret-leak; high=real product bug/wrong wire shape; medium=efficiency issue, misleading doc, missing safety-boundary test; low=dead code/cosmetic.
- Max 10 findings, ordered by severity. ZERO findings is a perfectly good answer if the dimension is clean — do NOT invent findings to look useful. Set dimension="${dim.key}" on each.`
}

// ---------------------------------------------------------------- phase 3: refuters

function refuterPrompt(f, siblings, pre) {
  return `You are an adversarial REFUTER. A reviewer claims the finding below. Your job is to REFUTE it — reproduce it from a cold start and only confirm if it survives your honest attempt to kill it.
${COMMON_RULES}
${READ_ONLY}

FINDING ${f.id}:
${JSON.stringify(findingBrief(f), null, 2)}

${siblings.length ? `Sibling findings touching the same files (for duplicate detection — if this finding is substantially the same defect as an earlier sibling, return status="duplicate" with duplicateOf set):
${JSON.stringify(siblings, null, 2)}` : ''}

Rules of evidence:
- Re-derive the claim INDEPENDENTLY — do not trust the reviewer's grep or summary. Counts/inventories by execution (recall the cautionary tale above).
- "confirmed" REQUIRES: you ran a repro (the reviewer's reproCommand or a better one you wrote) and you paste the observed output in reproOutput. No repro, no confirmation — downgrade to unverifiable with the reason.
- "refuted" REQUIRES: explain exactly what the reviewer mis-read (quote the code/output that disproves it).
- "unverifiable" is allowed and honest (e.g. prod-only audit-host behavior, requires credentials we don't have).
- ${pre.colleagueActive ? 'A colleague may be testing against the same live workspace: for live-failure findings, weigh shared-workspace pollution and Clockify name-reservation quirks (names stay reserved after archive-then-delete) before confirming a product bug.' : 'For live-failure findings, weigh Clockify name-reservation quirks (names stay reserved after archive-then-delete) before confirming a product bug.'}
- For api-drift findings: a code/spec divergence that is PINNED by a unit test as live-verified (tests/unit/rest-*.test.ts) is deliberate → refuted (the docs spec has been wrong before).
- You may adjust severity in either direction with justification (severityFinal).
- Test-gap findings: confirm = you verified the branch is genuinely uncovered (run the nearest test file, read it) and the proposed case is meaningful.`
}

// ---------------------------------------------------------------- phase 4: fixes

function fixBucket(f) {
  const sev = (f.verdict && f.verdict.severityFinal) || f.severity
  if (sev === 'critical') return 0
  if (f.dimension === 'security' || f.dimension === 'safety-invariants') return 0
  if (f.dimension === 'efficiency') return 2
  if (f.dimension === 'test-gaps') return 3
  if (f.dimension === 'dead-code') return 4
  if (f.dimension === 'doc-drift') return 5
  return 1 // live, eval, api-drift, truthfulness → product bugs
}

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 }

function fixPrompt(f, expectedHead) {
  const docOnly = f.dimension === 'doc-drift'
  const testGap = f.dimension === 'test-gaps'
  return `You implement ONE fix in the audit's sequential fix loop. TDD discipline per the repo's CLAUDE.md (read its "Engineering rules" + "Safety & planner invariants" sections first).
${COMMON_RULES}

CONFIRMED FINDING ${f.id} (refuter-verified):
${JSON.stringify(findingBrief(f), null, 2)}
Refuter verdict: ${trunc((f.verdict && (f.verdict.reasoning + ' | evidence: ' + (f.verdict.refuterEvidence || ''))) || 'n/a', 1500)}

PRECONDITIONS (step 0 — check before touching anything):
- cd ${REPO}; branch must be "main"; "git status --porcelain" empty; HEAD must be ${expectedHead}.
- If ANY precondition fails: return status="blocked", preconditionFailed=true, notes explaining. Do nothing else.

PROTOCOL:
${docOnly ? `This is a DOC-ONLY fix: no failing test. Instead, recompute the ground truth BY EXECUTION (run the command that proves the correct value/claim), fix the doc to match, and paste the command + output into the commit message body. Commit prefix "docs:".`
: testGap ? `This is a TEST-GAP fix: the deliverable is the new test itself.
1. Write the proposed test case. If it PASSES immediately, good — it pins the behavior (commit prefix "test:"). If it FAILS, you found a real bug: keep the test, apply the minimal fix, commit both together (prefix "fix(scope):").`
: `1. RED: write the failing test first (per proposedFix.failingTestFirst). Run ONLY that test file ("npx vitest run <file>") and confirm it fails FOR THE STATED REASON — paste the failure into notes. If you cannot make a test fail (the bug isn't real after all), return status="wont_fix" with the explanation; do not commit anything.
2. GREEN: minimal fix. No drive-by refactors, no unrelated cleanups.`}
3. GATE: "npm run verify" (judge by ITS exit code — never "verify | grep") AND "npx madge --circular --extensions ts --ts-config tsconfig.json src" = 0 cycles. Commit ONLY after both are green.
4. COMMIT: exactly one focused commit, message style matching "git log --oneline -10" (fix(scope):/test:/docs:). Never stage .env*, data/, eval-results/. Record the new sha.
${f.dimension === 'dead-code' ? '5. DEAD-CODE EXTRA: before deleting anything, paste grep proof that no string-keyed/runtime reference exists (identifier AND its string forms, incl. action-name strings, manifest paths, UI ids).' : ''}

ABORT RULES:
- Verify red after your fix → you get ONE more attempt within this task. Red twice → "git reset --hard ${expectedHead}", status="blocked", paste the failure in notes.
- If a SAFETY test fails at any point (anything pinning the invariants: confirmations, truthful previews, typed consent, policy gates): reset --hard immediately, status="blocked_safety", paste the failure. Do not try to "fix" a safety test.
- End with "git status --porcelain" empty either way (treeClean must be true).

Report FIX_SCHEMA: findingId="${f.id}", touchedPaths = files actually changed, attempts = how many red→green cycles you used.`
}

// ---------------------------------------------------------------- phase 5: gate + reruns

function gatePrompt(expectedFixCount, baselineTestCount) {
  return `Final verification gate after the audit's fix loop (${expectedFixCount} commits landed).
${COMMON_RULES}
Run, judging strictly by exit codes:
1. cd ${REPO} && npm run verify > /tmp/audit-final-verify.log 2>&1; echo EXIT=$? — parse the "Tests N passed" line. testCount must be ≥ ${baselineTestCount} (the baseline; fixes may have ADDED tests, never removed).
2. npx madge --circular --extensions ts --ts-config tsconfig.json src → must report 0 cycles.
3. git status --porcelain must be empty; report HEAD sha.
pass=true only if all three hold. On red, paste the verbatim failure excerpt into failures.`
}

function repairPrompt(failures, expectedHead) {
  return `The audit's FINAL GATE is red after the fix loop. You get ONE repair attempt.
${COMMON_RULES}
Failures (verbatim):
${trunc(failures, 6000)}

The fix-loop commits are on main (HEAD=${expectedHead}). Identify the offending commit ("git log --oneline", run the failing thing, bisect by reading the diffs — they are small and focused). Choose the smaller hammer:
- If a focused forward-fix is obvious: TDD it (failing test if applicable → minimal fix → verify+madge green → one commit).
- Otherwise REVERT the offending commit ("git revert --no-edit <sha>"), then verify+madge must be green.
Safety tests red → revert is the only allowed move. Never stage .env*, data/, eval-results/. End with a clean tree.
Report FIX_SCHEMA with findingId="gate-repair".`
}

function rerunSteps(touchedPaths, caps) {
  const t = touchedPaths
  const has = (re) => t.some((p) => re.test(p))
  const keys = []
  if (has(/^src\/(clockify|harness\/workflows)\//)) keys.push('live-full', 'live-sweep-final')
  if (has(/^src\/routes\//) || has(/^src\/harness\/(confirmations|actions|compose|idempotency|undo)/) || has(/^src\/assistant\/agent-(loop|state)/)) {
    keys.push('live-confirm-flow', 'live-agentic-flow')
  }
  if (has(/^src\/assistant\/(prompts|planner)/) || has(/^src\/harness\/(catalog|tools|arg-summary)/) || has(/^src\/harness\/workflows\//)) {
    keys.push('eval-planner')
  }
  if (has(/^src\/assistant\/agent-(loop|state)/)) keys.push('eval-agentic')
  const uniq = [...new Set(keys)]
  // sweep runs last if anything live runs
  const ordered = BATTERY_STEPS.filter((s) => uniq.includes(s.key) && s.key !== 'live-sweep-final' && s.needs.every((n) => caps[n]))
  if (ordered.some((s) => !s.eval)) {
    const sweep = BATTERY_STEPS.find((s) => s.key === 'live-sweep-final')
    if (caps.live) ordered.push(sweep)
  }
  return ordered
}

// ---------------------------------------------------------------- phase 6: report

function reportPrompt(summary, pre, docsCommitAllowed) {
  return `You write the audit report.
${COMMON_RULES}

Full run summary (JSON):
${JSON.stringify(summary, null, 2)}

1. APPEND a new section to ${NOTES_FILE} (create the file with a "# AI Assistant — Full-Angle Audit Notes" header if missing). Section header: "## Run ${pre.runId}". Include, in readable markdown: capabilities + every skipped angle WITH its reason; battery + eval results vs baselines (verbatim summary lines); a findings table per dimension (raw/confirmed/refuted/unverifiable/duplicate counts); each fix with commit sha + test file; blocked/deferred backlog (be explicit — silent omission is lying); eval deltas; the final gate result. Truthfulness over polish: report failures and skips plainly.
2. ${docsCommitAllowed
    ? `Update the "Current state" section of ${REPO}/CLAUDE.md with 1–3 lines recording this audit run (date, fixes landed count + areas, new test count, final gate green, pointer to ${NOTES_FILE}). Match the existing terse style. Then ONE commit: "docs: record the full-angle audit run in CLAUDE.md". Never stage .env*, data/, eval-results/. Tree clean afterward.`
    : 'Do NOT touch the repo (no fixes landed or the gate is red) — notes file only. docsCommitSha=null.'}
Report REPORT_SCHEMA. Put a 5-10 line human-readable digest of the run in "summary".`
}

// ================================================================ run

// ---- Phase 0
phase('Preflight')
let pre = await agent(preflightPrompt(), { schema: PREFLIGHT_SCHEMA, label: 'preflight' })
if (pre && !pre.ok && pre.baselineBroken) {
  log('Baseline is red — one TDD repair attempt before aborting')
  const repair = await agent(baselineRepairPrompt(pre), { schema: FIX_SCHEMA, label: 'baseline-repair' })
  if (repair && repair.status === 'fixed') {
    pre = await agent(preflightPrompt(), { schema: PREFLIGHT_SCHEMA, label: 'preflight-recheck' })
  }
}
if (!pre || !pre.ok) {
  return { aborted: true, reason: (pre && pre.abortReason) || 'preflight agent failed', preflight: pre }
}
const caps = {
  live: pre.capabilities.live && !SKIP_LIVE,
  server: pre.capabilities.server && !SKIP_LIVE,
  model: pre.capabilities.model && !SKIP_EVALS,
}
for (const w of pre.warnings || []) log(`preflight: ${w}`)
log(`Baseline ${pre.runId}: ${pre.baseline.testCount} tests, madge ${pre.baseline.madgeCycles} — caps live=${caps.live} server=${caps.server} model=${caps.model}`)

// ---- Phase 1
phase('Evidence')
const skipped = []
async function runBattery() {
  const results = []
  for (const step of BATTERY_STEPS) {
    const evalGated = step.eval && SKIP_EVALS
    const capOk = step.needs.every((n) => caps[n])
    if (!capOk || evalGated) {
      const reason = evalGated ? 'skipEvals arg' : `missing capability: ${step.needs.filter((n) => !caps[n]).join(',')}`
      skipped.push({ angle: step.key, reason })
      log(`SKIPPED ${step.key}: ${reason}`)
      results.push({ script: step.key, status: 'skipped', exitCode: null, summaryLine: '', skipReason: reason, metrics: null, findings: [] })
      continue
    }
    const r = await agent(batteryPrompt(step, pre), { schema: BATTERY_SCHEMA, phase: 'Evidence', label: `battery:${step.key}` })
    results.push(r || { script: step.key, status: 'fail', exitCode: null, summaryLine: 'battery agent died', skipReason: null, metrics: null, findings: [] })
    log(`battery ${step.key}: ${r ? r.status + ' — ' + trunc(r.summaryLine, 120) : 'agent died'}`)
  }
  return results
}
const [batteryResults, reviewResults] = await parallel([
  () => runBattery(),
  () => parallel(REVIEW_DIMENSIONS.map((d) => () => agent(reviewPrompt(d, pre), { schema: FINDINGS_SCHEMA, phase: 'Evidence', label: `review:${d.key}` }))),
])

// ---- Phase 2
phase('Merge')
const raw = []
for (const r of (reviewResults || []).filter(Boolean)) raw.push(...(r.findings || []))
for (const b of (batteryResults || []).filter(Boolean)) raw.push(...(b.findings || []))
const counters = {}
const seenKeys = new Set()
const findings = []
for (const f of raw) {
  const key = slug(f.title) + '|' + (f.proposedFix && f.proposedFix.touchPaths ? [...f.proposedFix.touchPaths].sort().join(',') : '')
  if (seenKeys.has(key)) continue
  seenKeys.add(key)
  counters[f.dimension] = (counters[f.dimension] || 0) + 1
  f.id = `${f.dimension}-${String(counters[f.dimension]).padStart(2, '0')}`
  findings.push(f)
}
log(`Merged ${raw.length} raw findings → ${findings.length} unique across ${Object.keys(counters).length} dimensions`)

// ---- Phase 3
phase('Verify findings')
if (findings.length) {
  const verdicts = await parallel(findings.map((f) => () => {
    const fPaths = new Set((f.files || []).map((x) => x.path))
    const siblings = findings
      .filter((g) => g.id !== f.id && (g.files || []).some((x) => fPaths.has(x.path)))
      .map((g) => ({ id: g.id, dimension: g.dimension, title: g.title, files: g.files }))
    return agent(refuterPrompt(f, siblings, pre), { schema: VERDICT_SCHEMA, phase: 'Verify findings', label: `refute:${f.id}` })
  }))
  findings.forEach((f, i) => { f.verdict = verdicts[i] || { status: 'unverifiable', reasoning: 'refuter agent died' } })
}
const confirmed = findings.filter((f) => f.verdict && f.verdict.status === 'confirmed')
const refuted = findings.filter((f) => f.verdict && f.verdict.status === 'refuted')
const unverifiable = findings.filter((f) => !f.verdict || f.verdict.status === 'unverifiable')
const duplicates = findings.filter((f) => f.verdict && f.verdict.status === 'duplicate')
log(`Verdicts: ${confirmed.length} confirmed / ${refuted.length} refuted / ${unverifiable.length} unverifiable / ${duplicates.length} duplicates`)

// ---- Phase 4
phase('Fix')
const queue = [...confirmed].sort((a, b) => {
  const bA = fixBucket(a), bB = fixBucket(b)
  if (bA !== bB) return bA - bB
  const sA = SEV_ORDER[(a.verdict && a.verdict.severityFinal) || a.severity] ?? 9
  const sB = SEV_ORDER[(b.verdict && b.verdict.severityFinal) || b.severity] ?? 9
  if (sA !== sB) return sA - sB
  return a.id < b.id ? -1 : 1
})
const toFix = queue.slice(0, MAX_FIXES)
const backlog = queue.slice(MAX_FIXES).map((f) => ({ findingId: f.id, status: 'deferred', reason: `over maxFixes=${MAX_FIXES}` }))
const fixResults = []
let headSha = pre.baseline.headSha
let consecutiveBlocked = 0
let halted = null
for (const f of toFix) {
  if (halted) { backlog.push({ findingId: f.id, status: 'deferred', reason: halted }); continue }
  const r = await agent(fixPrompt(f, headSha), { schema: FIX_SCHEMA, phase: 'Fix', label: `fix:${f.id}` })
  if (!r) {
    fixResults.push({ findingId: f.id, status: 'blocked', attempts: 0, treeClean: true, notes: 'fix agent died' })
    consecutiveBlocked++
  } else {
    fixResults.push(r)
    if (r.preconditionFailed) { halted = `fix ${f.id}: loop precondition violated (${trunc(r.notes || '', 200)})`; continue }
    if (r.status === 'blocked_safety') { halted = `fix ${f.id}: SAFETY test failed — stop-the-world per CLAUDE.md`; continue }
    if (r.status === 'fixed' && r.commitSha) { headSha = r.commitSha; consecutiveBlocked = 0 }
    else if (r.status === 'blocked') consecutiveBlocked++
    else consecutiveBlocked = 0
    log(`fix ${f.id}: ${r.status}${r.commitSha ? ' @ ' + r.commitSha.slice(0, 7) : ''}`)
  }
  if (consecutiveBlocked >= 2 && !halted) halted = 'two consecutive blocked fixes — systemic problem, human needed'
}
if (halted) log(`FIX LOOP HALTED: ${halted}`)
const landed = fixResults.filter((r) => r.status === 'fixed' && r.commitSha)

// ---- Phase 5
phase('Re-verify')
let gate = null
let rerunResults = []
let gateRepair = null
if (landed.length) {
  gate = await agent(gatePrompt(landed.length, pre.baseline.testCount), { schema: GATE_SCHEMA, phase: 'Re-verify', label: 'gate' })
  if (gate && !gate.pass) {
    log('Final gate RED — one repair attempt')
    gateRepair = await agent(repairPrompt(gate.failures || 'unknown', headSha), { schema: FIX_SCHEMA, phase: 'Re-verify', label: 'gate-repair' })
    if (gateRepair && gateRepair.commitSha) headSha = gateRepair.commitSha
    gate = await agent(gatePrompt(landed.length, pre.baseline.testCount), { schema: GATE_SCHEMA, phase: 'Re-verify', label: 'gate-recheck' })
  }
  const touched = [...new Set(landed.flatMap((r) => r.touchedPaths || []))]
  const steps = rerunSteps(touched, caps)
  if (steps.length) log(`Targeted re-runs for touched paths: ${steps.map((s) => s.key).join(' → ')}`)
  else log('No live/eval re-runs needed (touched paths are docs/tests/UI only)')
  for (const step of steps) {
    if (gate && !gate.pass) { log('Gate still red — skipping live re-runs'); break }
    const r = await agent(batteryPrompt(step, pre), { schema: BATTERY_SCHEMA, phase: 'Re-verify', label: `rerun:${step.key}` })
    rerunResults.push(r || { script: step.key, status: 'fail', summaryLine: 'rerun agent died', findings: [] })
    log(`rerun ${step.key}: ${r ? r.status : 'agent died'}`)
  }
  const rerunFails = rerunResults.filter((r) => r.status === 'fail')
  if (rerunFails.length && gate && gate.pass) {
    log(`${rerunFails.length} re-run(s) red — one repair attempt, then re-run the failures once`)
    const failText = rerunFails.map((r) => `${r.script}: ${r.summaryLine}\n${(r.findings || []).map((f) => f.evidence).join('\n')}`).join('\n---\n')
    const repair = await agent(repairPrompt(failText, headSha), { schema: FIX_SCHEMA, phase: 'Re-verify', label: 'rerun-repair' })
    if (repair && repair.commitSha) headSha = repair.commitSha
    for (const fail of rerunFails) {
      const step = BATTERY_STEPS.find((s) => s.key === fail.script)
      if (!step) continue
      const r2 = await agent(batteryPrompt(step, pre), { schema: BATTERY_SCHEMA, phase: 'Re-verify', label: `rerun2:${step.key}` })
      if (r2) { fail.status = r2.status; fail.summaryLine = r2.summaryLine; fail.rerunAfterRepair = true }
    }
    gate = await agent(gatePrompt(landed.length, pre.baseline.testCount), { schema: GATE_SCHEMA, phase: 'Re-verify', label: 'gate-final' })
  }
} else {
  log('No fixes landed — Phase 1 results stand as the verification record; skipping the gate re-run')
}
const finalGatePass = landed.length === 0 ? true : !!(gate && gate.pass && !rerunResults.some((r) => r.status === 'fail'))

// ---- Phase 6
phase('Report')
const summary = {
  runId: pre.runId,
  baseline: pre.baseline,
  capabilities: caps,
  colleagueActive: !!pre.colleagueActive,
  skippedAngles: skipped,
  battery: (batteryResults || []).filter(Boolean).map((b) => ({ script: b.script, status: b.status, summaryLine: trunc(b.summaryLine, 400), metrics: b.metrics, skipReason: b.skipReason })),
  findings: {
    raw: raw.length,
    unique: findings.length,
    confirmed: confirmed.map((f) => ({ id: f.id, title: f.title, severity: (f.verdict && f.verdict.severityFinal) || f.severity })),
    refuted: refuted.map((f) => ({ id: f.id, title: f.title, why: trunc(f.verdict.reasoning, 300) })),
    unverifiable: unverifiable.map((f) => ({ id: f.id, title: f.title, why: trunc((f.verdict && f.verdict.reasoning) || '', 300) })),
    duplicates: duplicates.map((f) => ({ id: f.id, duplicateOf: f.verdict.duplicateOf })),
  },
  fixes: fixResults.map((r) => ({ findingId: r.findingId, status: r.status, commitSha: r.commitSha || null, testFile: r.testFile || null, notes: trunc(r.notes || '', 300) })),
  backlog,
  halted,
  gate: gate ? { pass: gate.pass, testCount: gate.testCount, madgeCycles: gate.madgeCycles, headSha: gate.headSha, failures: trunc(gate.failures || '', 1000) } : null,
  gateRepair: gateRepair ? { status: gateRepair.status, commitSha: gateRepair.commitSha || null } : null,
  reruns: rerunResults.map((r) => ({ script: r.script, status: r.status, summaryLine: trunc(r.summaryLine, 300), rerunAfterRepair: !!r.rerunAfterRepair })),
  finalGate: finalGatePass ? 'pass' : 'fail',
}
const report = await agent(reportPrompt(summary, pre, landed.length > 0 && finalGatePass), { schema: REPORT_SCHEMA, label: 'report' })
summary.report = report || { notesWritten: false, docsCommitSha: null, summary: 'report agent died' }
return summary
