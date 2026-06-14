export const meta = {
  name: 'implement-chat-history-switcher',
  description: 'Autonomously implement the chat-history switcher (reopen past conversations) end-to-end on main: six sequential TDD phases from plans/008, one focused commit each (HEAD-gated, pushed after each), an IDOR-guard gate, a live smoke (create→list→switch→replay→IDOR on a real store, + an agent-browser click-through if the dev server is already up), then a final gate + push main. Fully resumable: landed phases are committed and skip on re-run.',
  whenToUse: 'Build the chat-history dropdown after the plans backlog (esp. plan 006) has landed — run the ship-plans-and-review workflow FIRST (008 depends on 006). Commits + pushes to main. Requires a clean tree + green verify to start. Reads plans/007 + plans/008 + plans/CC-WORKFLOW-BEST-PRACTICES.md.',
  phases: [
    { title: 'Preflight', detail: 'clean main, green verify, plan 006 present, capture HEAD' },
    { title: 'Build', detail: 'six sequential TDD phases (store → 2 routes → UI), one commit each, HEAD-gated, pushed' },
    { title: 'Live smoke', detail: 'create→list→switch→replay→IDOR on a real store; agent-browser click-through if the server is up; sweep' },
    { title: 'Verify', detail: 'full gate + cycles + IDOR test present & passing + scope-fence diff check + push main' },
    { title: 'Report', detail: 'summary: per-phase status, live smoke, gate, push' },
  ],
}

const REPO = '/Users/15x/Downloads/WORKING/addons-me/ai-assistant-addon'
const BRANCH = 'main' // everything lands on main (per the operator's decision), one green commit per phase, pushed

const RULES = `
Repo: ${REPO} — run everything from here. This is a deployed Clockify marketplace add-on; the safety boundary is sacred.
- READ FIRST: ${REPO}/CLAUDE.md ("Engineering rules" + "Safety & planner invariants"), ${REPO}/plans/007-chat-history-switcher-INVESTIGATION.md (session model + scope ruling + safety analysis), ${REPO}/plans/008-chat-history-switcher-IMPLEMENTATION.md (per-phase steps + exact code shapes).
- GATE: "npm run verify" (judge by its EXIT CODE, never "verify | grep") AND "npx madge --circular --extensions ts --ts-config tsconfig.json src" (= 0 cycles). Run one test file with "npx vitest run <path>".
- TDD: failing test FIRST, confirm it fails for the stated reason, then the minimal change, then the gate, then ONE Conventional-Commit. ESM (.js import suffixes). UI text via textContent ONLY (never innerHTML).
- HARD SCOPE FENCE (out of bounds — if a phase seems to need any of these, STOP with status="blocked_safety", git reset --hard, do NOT improvise): changing DEFAULT_SESSION_TTL_MS or the session expiry checks; reviving expired sessions (that is "Option B", gated on the human-only authz-surface-01 decision); editing src/harness/*, src/assistant/*, or any money path. This feature is route + UI + ONE store method ONLY.
- NEVER print values from .env/.env.server. NEVER "git add" .env*, data/, eval-results/, dist/.`

const PREFLIGHT_SCHEMA = {
  type: 'object',
  required: ['ok', 'headSha', 'treeClean', 'verifyGreen'],
  properties: {
    ok: { type: 'boolean' },
    headSha: { type: 'string', description: 'short HEAD sha of main at start' },
    treeClean: { type: 'boolean' },
    verifyGreen: { type: 'boolean' },
    plan006Present: { type: 'boolean', description: 'restoreHistory degrades a non-401 restore failure quietly (plan 006 landed)' },
    note: { type: ['string', 'null'] },
  },
}

const PHASE_SCHEMA = {
  type: 'object',
  required: ['phaseId', 'status', 'attempts', 'treeClean'],
  properties: {
    phaseId: { type: 'string' },
    status: { enum: ['done', 'blocked', 'blocked_safety'] },
    preconditionFailed: { type: 'boolean' },
    commitSha: { type: ['string', 'null'], description: 'short sha of the single commit this phase landed' },
    pushed: { type: 'boolean' },
    testFile: { type: ['string', 'null'] },
    touchedPaths: { type: 'array', items: { type: 'string' } },
    attempts: { type: 'number' },
    treeClean: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  },
}

const SMOKE_SCHEMA = {
  type: 'object',
  required: ['status', 'listOk', 'switchReplayOk', 'idorBlocked'],
  properties: {
    status: { enum: ['pass', 'fail', 'skipped'] },
    listOk: { type: 'boolean', description: 'GET /chat/sessions listed both conversations, current marked' },
    switchReplayOk: { type: 'boolean', description: 'switching re-cookied and /chat/history replayed the switched-to transcript' },
    idorBlocked: { type: 'boolean', description: 'a foreign/other-admin session id 404d with NO Set-Cookie' },
    browserChecked: { type: 'boolean', description: 'agent-browser click-through ran (server was up)' },
    sweepLeftovers: { type: ['number', 'null'] },
    evidence: { type: 'string' },
    failures: { type: ['string', 'null'] },
  },
}

const GATE_SCHEMA = {
  type: 'object',
  required: ['pass', 'madgeCycles', 'idorTestPresent', 'fenceClean'],
  properties: {
    pass: { type: 'boolean' },
    testCount: { type: ['number', 'null'] },
    madgeCycles: { type: 'number' },
    idorTestPresent: { type: 'boolean', description: 'an integration test asserts POST /api/chat/sessions/:id/open 404s for a foreign/other-admin session AND it passes' },
    fenceClean: { type: 'boolean', description: 'git diff shows NO edits to DEFAULT_SESSION_TTL_MS / session expiry / src/harness/* / src/assistant/* / money paths' },
    pushed: { type: 'boolean' },
    pushNote: { type: ['string', 'null'] },
    headSha: { type: ['string', 'null'] },
    failures: { type: ['string', 'null'] },
  },
}

function trunc(s, n) { return typeof s === 'string' && s.length > n ? s.slice(0, n) + ' …' : s }

// The six dependent build phases from plans/008. Each agent reads the matching "Phase N"
// section of plan 008 for exact code shapes — we keep the prompt to the contract + the one
// reminder per phase most likely to be gotten wrong.
const PHASES = [
  { id: 'p1-store-listSessions', planPhase: 'Phase 1', title: 'store.listSessions + index + SessionSummary type',
    critical: 'Return ONLY live (non-expired), owned (workspace+admin), NON-EMPTY sessions, newest-first. Add idx_chat_sessions_workspace_admin_expires. Unit-test that expired / empty / other-admin / other-workspace sessions are excluded.' },
  { id: 'p2-route-list', planPhase: 'Phase 2', title: 'GET /api/chat/sessions (session-gated, marks current)',
    critical: 'Mirror GET /chat/history. current = (s.id === claims.sessionId) computed IN THE ROUTE (the UI cannot know its own session id). No cookie → 401.' },
  { id: 'p3-route-switch', planPhase: 'Phase 3', title: 'POST /api/chat/sessions/:id/open — the IDOR-guarded switch',
    critical: 'WRITE THE IDOR TEST FIRST: an admin switching to ANOTHER admin/workspace session id must get 404 and NO Set-Cookie. Ownership check mirrors resolveSession; the re-cookie carries the TARGET session\'s own (UNEXTENDED) expiresAt. This is the security gate — never land it without the failing-then-passing IDOR test.' },
  { id: 'p4-ui-client', planPhase: 'Phase 4', title: 'ChatApi.listSessions + switchSession',
    critical: 'Mirror createFetchApi json()/newChat; encodeURIComponent the id. Unit-test the request paths/methods with a mock fetch.' },
  { id: 'p5-ui-dropdown', planPhase: 'Phase 5', title: 'renderChatsMenu builder (accessible, textContent-safe)',
    critical: 'Titles are UNTRUSTED workspace data — render via textContent ONLY (test with an <img>-containing title). role="menu"/menuitem, aria-current on the current item, keyboard nav (Enter/Space/Escape/Arrows), empty-state item.' },
  { id: 'p6-ui-wire', planPhase: 'Phase 6', title: 'wire the dropdown into the header + switch flow',
    critical: 'On select: switchSession → on success mirror startNewChat\'s reset → restoreHistory() to replay; on failure showError honestly and KEEP the current chat. Return focus to the toggle. Keep cycles at 0.' },
]

function phasePrompt(p, expectedHead) {
  return `Implement ONE phase of the chat-history switcher with strict TDD, directly on main.
${RULES}

PHASE ${p.id}: ${p.title}
Read plans/008-chat-history-switcher-IMPLEMENTATION.md → "${p.planPhase}" for the exact files, code shapes, and test cases. Read plans/007 for the session model + safety analysis.
CRITICAL FOR THIS PHASE: ${p.critical}

PRECONDITIONS (verify, else status="blocked" + preconditionFailed=true, do nothing else):
  cd ${REPO}; current branch === "${BRANCH}"; "git status --porcelain" empty; "git rev-parse --short HEAD" === ${expectedHead}.

PROTOCOL:
1. RED: write the failing test(s) FIRST (the cases named in 008 ${p.planPhase}). Run only that file ("npx vitest run <path>") and confirm it FAILS for the stated reason (paste the failure into notes).
2. GREEN: the minimal implementation from 008 ${p.planPhase}. No drive-by refactors, no unrelated files.
3. GATE: "npm run verify" (judge by EXIT CODE) AND "npx madge --circular --extensions ts --ts-config tsconfig.json src" (= 0). Commit ONLY after both are green.
4. ONE focused commit (feat(...)/test(...), repo log style). Never stage .env*, data/, eval-results/, dist/.
5. PUSH (best-effort): "git push origin main 2>&1" — set pushed=true on success; on a rejection (auth/protected) set pushed=false and quote it in notes, do NOT force-push or change git config (the commit is safe locally).

ABORTS: verify red twice after reasonable fixes → "git reset --hard ${expectedHead}", status="blocked". If the phase appears to require a SCOPE-FENCED change (session TTL, expiry, reviving sessions, src/harness/*, src/assistant/*) → "git reset --hard ${expectedHead}", status="blocked_safety", explain in notes — NEVER cross the fence.

End with a clean tree (treeClean=true). Report PHASE_SCHEMA: phaseId="${p.id}", commitSha = the short sha you committed (or null), touchedPaths = files changed.`
}

// ================================================================ run

phase('Preflight')
const pre = await agent(`Preflight for the chat-history-switcher build (lands on main).
${RULES}

Do, then report PREFLIGHT_SCHEMA:
1. cd ${REPO}. Confirm branch is "${BRANCH}" and "git status --porcelain" is empty (treeClean). If NOT clean, ok=false (do not stash/discard work).
2. Confirm the starting tree is green: "npm run verify" judged by EXIT CODE (verifyGreen). If red, ok=false and paste the failure in note — we must start from green.
3. plan006Present: plan 008 depends on plan 006 (a graceful empty/failed history restore). Confirm 006 landed: in src/ui/main.ts, restoreHistory's catch degrades a NON-401 failure quietly (a console.warn, NOT an unconditional red showError) while still surfacing the 401 case; and src/ui/shared.ts historyRestoreItems is shape-safe for undefined/empty input. true if both hold. If false, set a note (the build can still proceed, but the "switch to an empty/older session" UX relies on 006).
4. headSha = "git rev-parse --short HEAD". ok = treeClean && verifyGreen.
Do NOT print secrets. Do NOT commit anything in preflight.`,
  { schema: PREFLIGHT_SCHEMA, label: 'preflight' })

if (!pre || !pre.ok) {
  return { aborted: true, reason: 'preflight failed (need a clean tree + green verify on main)', pre }
}
let headSha = pre.headSha
if (pre.plan006Present === false) log('WARNING: plan 006 (graceful restore) not detected — run ship-plans-and-review first; proceeding, but the empty-session-switch UX may alarm')
log(`Preflight ok on ${BRANCH} @ ${headSha}; building ${PHASES.length} phases`)

phase('Build')
const results = []
let consecutiveBlocked = 0
let halted = null
for (const p of PHASES) {
  if (halted) { results.push({ phaseId: p.id, status: 'blocked', attempts: 0, treeClean: true, notes: 'halted: ' + halted }); continue }
  const r = await agent(phasePrompt(p, headSha), { schema: PHASE_SCHEMA, phase: 'Build', label: p.id })
  if (!r) { results.push({ phaseId: p.id, status: 'blocked', attempts: 0, treeClean: true, notes: 'agent died' }); consecutiveBlocked++ }
  else {
    results.push(r)
    if (r.preconditionFailed) { halted = `precondition at ${p.id} (${trunc(r.notes || '', 160)})`; continue }
    if (r.status === 'blocked_safety') { halted = `SCOPE FENCE hit at ${p.id} — ${trunc(r.notes || '', 200)}`; continue }
    if (r.status === 'done' && r.commitSha) { headSha = r.commitSha.slice(0, 9); consecutiveBlocked = 0 }
    else { consecutiveBlocked++ }
    log(`${p.id}: ${r.status}${r.commitSha ? ' @ ' + r.commitSha.slice(0, 7) + (r.pushed ? ' (pushed)' : ' (local)') : ''}`)
  }
  if (consecutiveBlocked >= 2 && !halted) halted = 'two consecutive blocked phases'
}
if (halted) log(`BUILD HALTED: ${halted}`)
const landed = results.filter((r) => r.status === 'done' && r.commitSha)
const allSix = landed.length === PHASES.length

phase('Live smoke')
let smoke = null
if (allSix) {
  smoke = await agent(`Live smoke of the chat-history switcher you just built — prove list → switch → replay end-to-end on a REAL store, and that the IDOR guard blocks a foreign session. The new routes are pure session/store ops (no Clockify calls), so the meaningful live proof is an HTTP smoke on a real better-sqlite3 DB with real signed cookies.
${RULES}

PRIMARY (always): write a THROWAWAY script at /tmp/chsw-smoke.ts (do NOT add it to git) that, modeled on tests/integration/chat-history.test.ts + chat-sessions.test.ts, builds the real app via createApp with a REAL store backed by a temp sqlite file (better-sqlite3, e.g. /tmp/chsw-smoke.sqlite) and the existing fake model, then drives:
  1. Mint an admin session (ws=WS, admin=A). Create TWO conversations (a fresh session each via /chat/new), each with a couple of user turns so both are non-empty.
  2. GET /api/chat/sessions → assert BOTH are listed, newest-first, current marked → listOk.
  3. POST /api/chat/sessions/<the other owned session id>/open → assert 200 + a Set-Cookie; then GET /api/chat/history with that new cookie → assert it replays the SWITCHED-TO session's messages → switchReplayOk.
  4. IDOR: create a session for a DIFFERENT admin/workspace; with admin A's cookie POST /api/chat/sessions/<that foreign id>/open → assert 404 AND no Set-Cookie → idorBlocked.
Run it ("npx tsx --env-file=.env.server /tmp/chsw-smoke.ts" — env only for config; the smoke does NOT call Clockify). Capture pass/fail per assertion. Delete /tmp/chsw-smoke.ts + the temp sqlite when done.

SECONDARY (best-effort, ONLY if the dev server is already up — "scripts/dev-tunnel.sh status" reports up; NEVER start/restart it): via agent-browser, load <BASE_URL>/tracker, click the "AI ASSISTANT" sidebar link (SPA nav), get the cross-origin iframe frame, click the header "Chats ▾" toggle, confirm the dropdown lists conversations, switch to one, confirm the transcript replays. Set browserChecked accordingly. If the server is down, browserChecked=false (skip — do not start it).

FINALLY: run "LIVE_CLOCKIFY=1 npx tsx --env-file=.env --env-file=.env.server scripts/live-sweep.ts" and report sweepLeftovers (expect 0; the smoke shouldn't create Clockify entities, this just confirms the workspace is clean).

status="pass" only if listOk && switchReplayOk && idorBlocked. Report SMOKE_SCHEMA with a verbatim evidence excerpt. Never print secrets; never commit the throwaway script.`,
    { schema: SMOKE_SCHEMA, label: 'live-smoke' })
  log(`Live smoke: ${(smoke && smoke.status) || 'fail'} (list=${smoke && smoke.listOk} switch=${smoke && smoke.switchReplayOk} idor=${smoke && smoke.idorBlocked}${smoke && smoke.browserChecked ? ' +browser' : ''})`)
} else {
  log('Not all six phases landed — skipping live smoke')
}

phase('Verify')
let gate = null
if (landed.length) {
  gate = await agent(`Final verification of the chat-history-switcher build, then push main.
${RULES}

Run, judging by exit codes, and report GATE_SCHEMA:
1. cd ${REPO} && npm run verify > /tmp/chsw-verify.log 2>&1; echo EXIT=$? — pass=(EXIT==0); parse "Tests  N passed" → testCount.
2. npx madge --circular --extensions ts --ts-config tsconfig.json src → madgeCycles (expect 0).
3. idorTestPresent: search the integration tests for an assertion that POST /api/chat/sessions/:id/open returns 404 when the target session belongs to a DIFFERENT admin or workspace — true ONLY if such a test exists AND passes (run that file to confirm). This is the security gate.
4. fenceClean: "git --no-pager diff ${pre.headSha}..HEAD" must show NO edits to DEFAULT_SESSION_TTL_MS, the session expiry checks (getSession/sessions.ts expiry), src/harness/*, src/assistant/*, or any money path. true if the diff is confined to the store method + index, the two routes, and the UI (+ their tests + styles). false (and quote the offending hunk) otherwise.
5. headSha = git rev-parse --short HEAD; confirm "git status --porcelain" is empty.
6. PUSH — only if pass && madgeCycles===0 && idorTestPresent && fenceClean && clean tree: "git push origin main 2>&1" → pushed + pushNote (quote a rejection verbatim; do NOT force-push or change git config). If ANY gate fails, do NOT push: pushed=false, pushNote explains, paste the failure in failures.
Never print secrets.`,
    { schema: GATE_SCHEMA, label: 'final-gate-push' })
} else {
  log('No phases landed — skipping final gate')
}

phase('Report')
const finalGate = landed.length === 0
  ? 'n/a'
  : (gate && gate.pass && gate.idorTestPresent && gate.fenceClean && gate.madgeCycles === 0 ? 'pass' : 'fail')
return {
  branch: BRANCH,
  startSha: pre.headSha,
  endSha: (gate && gate.headSha) || headSha,
  phases: results.map((r) => ({ phaseId: r.phaseId, status: r.status, commitSha: r.commitSha || null, pushed: !!r.pushed, testFile: r.testFile || null, notes: trunc(r.notes || '', 220) })),
  landed: landed.length,
  allSix,
  halted,
  liveSmoke: smoke ? { status: smoke.status, listOk: smoke.listOk, switchReplayOk: smoke.switchReplayOk, idorBlocked: smoke.idorBlocked, browserChecked: smoke.browserChecked, sweepLeftovers: smoke.sweepLeftovers, failures: trunc(smoke.failures || '', 400) } : null,
  gate: gate ? { pass: gate.pass, testCount: gate.testCount, madgeCycles: gate.madgeCycles, idorTestPresent: gate.idorTestPresent, fenceClean: gate.fenceClean, pushed: gate.pushed, pushNote: gate.pushNote || null, failures: trunc(gate.failures || '', 800) } : null,
  finalGate,
  pushedMain: !!(gate && gate.pushed),
  outcome: finalGate === 'pass'
    ? (gate.pushed ? 'GREEN — chat-history switcher on main, IDOR-guarded, live-smoked, pushed' : 'GREEN locally — gate passed but push did not land (see pushNote); commits are safe, push manually')
    : (halted ? `HALTED (${halted}) — landed phases are committed; resolve and re-run (they skip via HEAD precondition)` : 'NEEDS ATTENTION — final gate not clean (IDOR test / fence / verify); review before pushing'),
  nextStep: halted
    ? `Build halted (${halted}). Inspect main, resolve, and re-run — completed phases are committed and skip via their HEAD precondition.`
    : (finalGate === 'pass' ? 'Feature complete on main. Optional: agent-browser dogfood against the live embedded chat; deploy via "railway up" when ready.' : 'Resolve the failing gate item (esp. the IDOR test / scope fence) before pushing.'),
}
