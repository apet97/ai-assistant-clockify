export const meta = {
  name: 'finish-plans-and-fixes',
  description: 'Finish the ship-plans backlog: land plan 004 (pagination truncation, EXTENDED to the two time-tracking getEntries callers its STOP condition flagged) + plan 006 (graceful restore), and the confirmed adversarial-review findings F2/F6/F7/F8/F9 — each a TDD commit directly on main, HEAD-gated, no branches. Then a non-gating live re-check (live-confirm-flow flake + live-full F8/F9) and an offline-gated push.',
  whenToUse: 'Run AFTER ship-plans-and-review landed 001/002/003/005 + fixes F3/F10 on main (it stranded the rest on an advisor/ branch, now recovered). This lands the remaining product work. Requires a clean tree + green verify on main.',
  phases: [
    { title: 'Preflight', detail: 'clean main, green verify, capability flags' },
    { title: 'Land', detail: 'plans 004(+callers)/006 + findings F2/F6/F7/F8/F9, sequential TDD, one commit each' },
    { title: 'Live recheck', detail: 're-run live-confirm-flow + live-full on the sacrificial WS (non-gating, honest report)' },
    { title: 'Push', detail: 'final offline gate (verify+cycles) + push main' },
    { title: 'Report', detail: 'summary' },
  ],
}

const REPO = '/Users/15x/Downloads/WORKING/addons-me/ai-assistant-addon'
const WORKSPACE_ID = '65b382b606de527a7ee2b60e' // sacrificial WS ("WORKSPACE", dev/test account); owner member user id 64621faec4d2cc53b91fce6c

const RULES = `
Repo: ${REPO} — run every command from here. Deployed Clockify marketplace add-on; the preview->confirm safety boundary (src/harness/*) is sacred.
- GATE: "npm run verify" (judge by EXIT CODE, never "verify | grep"; it now includes the madge cycles check). Run one test file with "npx vitest run <path>".
- TDD: failing test FIRST (confirm it fails for the stated reason), then the minimal change, then the gate, then ONE Conventional-Commit. ESM (.js import suffixes). UI text via textContent ONLY.
- COMMIT DIRECTLY TO main. NEVER create or switch git branches (no "git checkout -b/-B", "git switch -c", "git branch <name>"). Any "Branch advisor/…" line in a plan is OVERRIDDEN — stay on main. (A prior run leaked work onto an advisor/ branch by obeying that line.)
- NEVER print values from .env/.env.server. NEVER "git add" .env*, data/, eval-results/, dist/.`

const ITEM_SCHEMA = {
  type: 'object',
  required: ['itemId', 'status', 'attempts', 'treeClean'],
  properties: {
    itemId: { type: 'string' },
    status: { enum: ['done', 'blocked', 'blocked_safety', 'wont_fix'] },
    preconditionFailed: { type: 'boolean' },
    commitSha: { type: ['string', 'null'] },
    testFiles: { type: 'array', items: { type: 'string' } },
    touchedPaths: { type: 'array', items: { type: 'string' } },
    attempts: { type: 'number' },
    treeClean: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  },
}

const RECHECK_SCHEMA = {
  type: 'object',
  required: ['script', 'status', 'summaryLine'],
  properties: {
    script: { type: 'string' },
    status: { enum: ['pass', 'fail', 'flake', 'skipped'] },
    summaryLine: { type: 'string' },
    note: { type: ['string', 'null'] },
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
    pushed: { type: 'boolean' },
    pushNote: { type: ['string', 'null'] },
    failures: { type: ['string', 'null'] },
  },
}

function trunc(s, n) { return typeof s === 'string' && s.length > n ? s.slice(0, n) + ' …' : s }

// The remaining work, dependency-ordered. Each item is self-contained (agents don't share context).
const ITEMS = [
  {
    id: '004-pagination-truncation',
    title: 'plan 004: signal pagination truncation (EXTENDED to the 2 time-tracking callers)',
    prompt: `Land plan 004 (signal pagination truncation), EXTENDED to resolve its STOP condition.
Read ${REPO}/plans/004-signal-pagination-truncation.md IN FULL. Run its Drift check first.
PART A (core): add core.paginateWithMeta(host,path,params) -> { rows, truncated } (truncated = all MAX_PAGES pages were full), make paginate() delegate, warn ONCE on truncation. Do NOT change MAX_PAGES/PAGE_SIZE. Update tests/unit/rest-core.test.ts: the backstop test now asserts paginateWithMeta(...).truncated===true (drop the "truncated silently" comment) + a sibling case asserting false on a short final page.
PART B (entries): thread truncated through getEntries — ports/time-entries.ts return type -> { entries: TimeEntrySummary[]; truncated: boolean }; rest/time-entries.ts uses paginateWithMeta and returns { entries: rows.map(mapEntry), truncated }; the fake (tests/helpers/fake/time-entries.ts) returns { entries:[...], truncated:false }; src/harness/workflows/entries.ts (clockify_entries_list) destructures { entries: items, truncated } and adds the list_truncated warning + data.truncated (mirror exportInvoice).
PART B' (RESOLVES THE STOP CONDITION — the plan only accounted for ONE getEntries caller, but there are TWO MORE in src/harness/workflows/time-tracking.ts: clockify_review_day (~line 315) and clockify_review_week (~line 351), which compute totalMinutes(entries) — truncation matters MOST here, since a truncated list yields a WRONG total). Update BOTH: "const { entries, truncated } = await ctx.clockify.getEntries(...)", keep using entries for count/totalMinutes, and add the SAME list_truncated warning + data.truncated when truncated (a truncated review = an understated total; the caveat must say so). Update the review_day/review_week tests (grep tests for clockify_review_day/getEntries) for the new fake shape + a truncated case.
This subsumes review finding F4. Commit message(s) per the plan (Part A then Part B, or one focused commit covering A+B+B'). Update the plans/README.md 004 status row to DONE in the final commit.`,
  },
  {
    id: '006-graceful-restore',
    title: 'plan 006: degrade quietly on a benign/failed chat-history restore',
    prompt: `Land plan 006 (graceful empty/failed history restore). Read ${REPO}/plans/006-graceful-history-restore.md IN FULL. Run its Drift check first.
Failing test FIRST: in the existing historyRestoreItems test file (grep tests for historyRestoreItems), add cases historyRestoreItems(undefined) -> [], historyRestoreItems({}) -> [], historyRestoreItems({messages:[],pendingPreviews:[]}) -> [] (they THROW today). Then make src/ui/shared.ts historyRestoreItems shape-safe (coerce missing messages/pendingPreviews to []). Then in src/ui/main.ts restoreHistory's catch: a NON-401 failure degrades quietly (console.warn, NO red showError) while the 401/session-expired case STILL surfaces (showError); restoreGate.settle() must still run on every path (success, quiet-failure, 401). Do NOT touch the server route. This subsumes review finding F5. ONE-or-two commits per the plan; update the plans/README.md 006 status row to DONE.`,
  },
  {
    id: 'F2-truthful-comment',
    title: 'F2: correct the false best-effort-bookkeeping comment (no re-attempt on re-confirm)',
    prompt: `Fix confirmed finding F2 (truthfulness, low): in src/routes/api.ts, plan 003's post-commit best-effort try/catch carries a code COMMENT claiming a later re-confirm "replays idempotently and re-attempts the bookkeeping" — that is FALSE: markConfirmationUsed already marked the confirmation 'used' BEFORE the commit, so a re-confirm returns 409 not_pending and NEVER re-runs the post-commit bookkeeping. So a dropped addAuditEvent is permanently lost from the audit-backed recap. Correct the comment to state the truth: the post-commit bookkeeping is best-effort and a failure here means the audit entry / undo handle may be permanently missing for THIS receipt (the committed write itself is safe via the idempotency ledger; the receipt is still returned to the admin) — a re-confirm does NOT recover it. Keep it concise and in the repo's comment voice. Comment-only change (no behavior change) → no new test needed, but run the full gate and confirm green before the ONE commit (docs/refactor prefix). Do NOT alter any logic in the try/catch.`,
  },
  {
    id: 'F6-undo-bookkeeping-test',
    title: 'F6: pin the 3rd post-commit write — recordUndoIfReversible throwing at confirm',
    prompt: `Fix confirmed finding F6 (test-gap, low): plan 003 wrapped all THREE post-commit bookkeeping writes (setConfirmationResult, addAuditEvent, recordUndoIfReversible) in a best-effort try/catch, but the tests only exercise the first two throwing. ADD a test (extend tests/integration/commit-bookkeeping.test.ts or the safe-write-audit test — grep tests for setConfirmationResult/addAuditEvent throwing to find the pattern) that injects a throwing recordUndoIfReversible path (wrap the fake store so store.recordUndoable — the method recordUndoIfReversible calls — throws once) and asserts the confirm STILL returns 200 + the committed receipt (NOT a 500), and the commit ran exactly once. This is a test-only addition (test: commit). Confirm it FAILS if the try/catch were removed (sanity), then green, then the gate, then ONE commit.`,
  },
  {
    id: 'F7-isolate-reply-persist',
    title: 'F7: isolate persistAssistantReply so a throwing addMessage cannot 500 a turn whose write already ran',
    prompt: `Fix confirmed finding F7 (test-gap/robustness, low) — the SAME un-isolated class F3 fixed for the safe-write audit, now for the assistant-reply persistence on the chat turn. In src/routes/api.ts, executeChatTurn calls persistAssistantReply (which calls store.addMessage) AFTER the action(s) executed; if addMessage throws, the whole turn 500s even though the write already happened and the admin should get the reply.
FAILING TEST FIRST: an integration test (model after tests/integration/safe-write-audit.test.ts) where the fake store's addMessage throws on the assistant-reply write during a turn that ran a safe write — assert the turn does NOT 500 and still returns the receipt/reply (today it 500s).
FIX: isolate ONLY the persistAssistantReply / addMessage call in a try/catch that logs the MESSAGE only (per src/server.ts convention) and continues — mirror F3's safe-write isolation exactly. Do NOT touch the truthful-preview replacement, the typed-consent guard, sanitizeStoredReplyForModel, or the action execution. If isolating it cleanly is impossible without changing turn control flow, status="wont_fix" with the reason (do NOT force it). ONE commit (fix(routes):), gate green first.`,
  },
  {
    id: 'F8F9-live-full-fixtures',
    title: 'F8/F9: refresh the stale live-full fixtures (product is correct; the fixtures pass invalid data)',
    prompt: `Fix confirmed findings F8 + F9 (live, medium) — these are STALE LIVE-TEST FIXTURES in scripts/live-full.ts, NOT product bugs (the product correctly CLARIFIES on the invalid input; the live harness counts that as FAIL because it expected success).
F8: the users_role_update fixture passes an unsupported entityId, so the scope resolver clarifies. F9: the users_deactivate fixture passes a nonexistent member 'smoke-user', so the user resolver clarifies.
FIX (read scripts/live-full.ts; mirror how OTHER fixtures in it resolve real members/scopes): make both exercise the SUCCESS path with VALID data for the sacrificial workspace ${WORKSPACE_ID} — prefer resolving a REAL member dynamically (the script already has live API access — list the workspace's users and pick the owner / a real member; owner user id is 64621faec4d2cc53b91fce6c) rather than a hardcoded placeholder, and use a SUPPORTED scope for users_role_update (e.g. role WORKSPACE_ADMIN with entityId = the workspaceId, per CLAUDE.md "Role grant is POST /users/{RECIPIENT}/roles {entityId,role}"). If the action is genuinely unsupported for the add-on/api-key class, make the fixture EXPECT the clarify/unsupported result instead of success (so it stops counting as FAIL). The validation is a live-full re-run in the next phase — you do NOT need to run the full 30-min live-full yourself; just make the fixture correct and confirm "npm run type-check" + "npm run build" stay green (live-full.ts is TS). ONE commit (test/chore: refresh stale live-full fixtures). This is scripts/ only — do NOT change product code in src/.`,
  },
]

function itemPrompt(it, expectedHead) {
  return `Land ONE item directly on main with strict TDD discipline (read CLAUDE.md "Engineering rules" + "Safety & planner invariants" first).
${RULES}

ITEM ${it.id}: ${it.title}
${it.prompt}

PRECONDITIONS (check, else status="blocked" + preconditionFailed=true, do nothing else):
  cd ${REPO}; branch === "main"; "git status --porcelain" empty; "git rev-parse --short HEAD" === ${expectedHead}.

PROTOCOL: RED (failing test first where the item is a behavior change) -> GREEN (minimal) -> GATE ("npm run verify" by EXIT CODE; it includes cycles) -> ONE focused commit (never stage .env*/data//eval-results//dist/). Do NOT create a branch.
ABORTS: verify red twice -> "git reset --hard ${expectedHead}", status="blocked". A SAFETY test fails (confirmations/truthful previews/typed consent/policy gate) -> reset --hard, status="blocked_safety", never weaken a safety test. End with a clean tree.
Report ITEM_SCHEMA: itemId="${it.id}", commitSha = your commit's short sha (or null), testFiles, touchedPaths.`
}

// ================================================================ run

phase('Preflight')
const pre = await agent(`Preflight for the finish-plans-and-fixes run (everything lands on main).
${RULES}
Report JSON {ok, headSha, treeClean, verifyGreen, caps:{live,model}, note}:
1. branch === "main" and "git status --porcelain" empty (treeClean). If not, ok=false.
2. "npm run verify > /tmp/finish-baseline.log 2>&1; echo EXIT=$?" — verifyGreen=(EXIT==0); if red, ok=false + paste the failure in note.
3. caps.live = LIVE_CLOCKIFY_API_KEY + LIVE_WORKSPACE_ID present in .env AND LIVE_WORKSPACE_ID value === ${WORKSPACE_ID} (compare WITHOUT printing it). caps.model = LLM_API_KEY present in .env.server. (presence only — never print values.)
4. headSha = "git rev-parse --short HEAD". ok = treeClean && verifyGreen.`,
  { schema: { type: 'object', required: ['ok', 'headSha'], properties: { ok: { type: 'boolean' }, headSha: { type: 'string' }, treeClean: { type: 'boolean' }, verifyGreen: { type: 'boolean' }, caps: { type: 'object', properties: { live: { type: 'boolean' }, model: { type: 'boolean' } } }, note: { type: ['string', 'null'] } } }, label: 'preflight' })

if (!pre || !pre.ok) { return { aborted: true, reason: 'preflight failed (need clean main + green verify)', pre } }
let headSha = pre.headSha
const caps = pre.caps || { live: false, model: false }
log(`Preflight ok @ ${headSha} · live=${caps.live} model=${caps.model}`)

phase('Land')
const results = []
let halted = null
let consecutiveBlocked = 0
for (const it of ITEMS) {
  if (halted) { results.push({ itemId: it.id, status: 'blocked', attempts: 0, treeClean: true, notes: 'halted: ' + halted }); continue }
  const r = await agent(itemPrompt(it, headSha), { schema: ITEM_SCHEMA, phase: 'Land', label: it.id })
  if (!r) { results.push({ itemId: it.id, status: 'blocked', attempts: 0, treeClean: true, notes: 'agent died' }); consecutiveBlocked++ }
  else {
    results.push(r)
    if (r.preconditionFailed) { halted = `precondition at ${it.id} (${trunc(r.notes || '', 160)})`; continue }
    if (r.status === 'blocked_safety') { halted = `SAFETY at ${it.id} — ${trunc(r.notes || '', 200)}`; continue }
    if (r.status === 'done' && r.commitSha) { headSha = r.commitSha.slice(0, 9); consecutiveBlocked = 0 }
    else if (r.status === 'blocked') consecutiveBlocked++
    else consecutiveBlocked = 0 // wont_fix doesn't advance HEAD but isn't a block
    log(`${it.id}: ${r.status}${r.commitSha ? ' @ ' + r.commitSha.slice(0, 7) : ''}`)
  }
  if (consecutiveBlocked >= 2 && !halted) halted = 'two consecutive blocked items'
}
const landed = results.filter((r) => r.status === 'done' && r.commitSha)
log(`Land: ${landed.length}/${ITEMS.length} done${halted ? ` — HALTED: ${halted}` : ''}`)

phase('Live recheck')
// Non-gating: confirm the live-confirm-flow flake clears and live-full's F8/F9 FAILs are gone.
// The push is gated on the OFFLINE verify, not on these (live infra can be transiently flaky).
let recheck = []
if (caps.live && caps.model) {
  const steps = [
    { key: 'live-confirm-flow', cmd: 'npx tsx --env-file=.env.server scripts/live-confirm-flow.ts', expect: 'Expect "== Summary == PASS=16 FAIL=0". The prior run threw a transient HTML error page mid-setup (NOT a code bug) — status="flake" if it errors on an HTML/JSON parse again (note it), "pass" on PASS=16, "fail" only on a real PASS<16/FAIL>0 with a safety assertion failing.' },
    { key: 'live-full', cmd: 'LIVE_CLOCKIFY=1 npx tsx --env-file=.env --env-file=.env.server scripts/live-full.ts', expect: 'Expect FAIL=0 now that F8/F9 fixtures are fixed. Summary "PASS=… FAIL=… …". status="pass" if FAIL=0; "fail" with the FAIL action names in note otherwise. 10-30 min — run in background and poll.' },
  ]
  recheck = await parallel(steps.map((s) => () =>
    agent(`Re-run ONE live battery step on the sacrificial workspace and report honestly.
${RULES}
Step ${s.key}: cd ${REPO} && ${s.cmd}  (tee to /tmp/finish-${s.key}.log; capture the real exit code; long runs background+poll).
${s.expect}
Report RECHECK_SCHEMA: script="${s.key}", the verbatim summary line, status, and a note (any FAIL action names or the flake reason). Never print secrets.`,
      { schema: RECHECK_SCHEMA, phase: 'Live recheck', label: `recheck:${s.key}` })))
  recheck = recheck.filter(Boolean)
  for (const r of recheck) log(`recheck ${r.script}: ${r.status} — ${trunc(r.summaryLine || r.note || '', 90)}`)
} else {
  log('Live recheck skipped (capability missing)')
}

phase('Push')
const gate = await agent(`Final OFFLINE gate for the finish run, then push main.
${RULES}
Report GATE_SCHEMA, judging by exit codes:
1. cd ${REPO} && npm run verify > /tmp/finish-final.log 2>&1; echo EXIT=$? — pass=(EXIT==0); parse "Tests  N passed" -> testCount; the run includes the madge cycles check -> madgeCycles (0 expected; if "circular dependency found" appears, madgeCycles>0 and pass=false).
2. headSha = git rev-parse --short HEAD; confirm "git status --porcelain" empty.
3. ONLY IF pass && madgeCycles===0 && clean tree: "git push origin main 2>&1" -> pushed + pushNote (quote a rejection verbatim; do NOT force-push or change git config). If the gate is red, do NOT push: pushed=false, paste the failure in failures.
Never print secrets.`,
  { schema: GATE_SCHEMA, label: 'final-gate-push' })

phase('Report')
return {
  startSha: pre.headSha,
  endSha: (gate && gate.headSha) || headSha,
  items: results.map((r) => ({ itemId: r.itemId, status: r.status, commitSha: r.commitSha || null, notes: trunc(r.notes || '', 220) })),
  landed: landed.length,
  halted,
  liveRecheck: recheck.map((r) => ({ script: r.script, status: r.status, summary: trunc(r.summaryLine || '', 120), note: trunc(r.note || '', 200) })),
  finalGate: gate ? { pass: gate.pass, testCount: gate.testCount, madgeCycles: gate.madgeCycles, pushed: gate.pushed, pushNote: gate.pushNote || null, failures: trunc(gate.failures || '', 700) } : null,
  pushedMain: !!(gate && gate.pushed),
  outcome: (gate && gate.pass && gate.madgeCycles === 0)
    ? (gate.pushed ? `GREEN — ${landed.length}/${ITEMS.length} items on main, pushed` : 'GREEN locally — gate passed but push did not land (see pushNote); push manually')
    : 'NEEDS ATTENTION — final gate not clean; review failures',
  nextStep: halted
    ? `Halted (${halted}) — landed items are committed; resolve and re-run (they skip via HEAD precondition).`
    : 'Plans backlog + review fixes complete on main. Next: run implement-chat-history-switcher (the feature, depends on plan 006 now landed).',
}
