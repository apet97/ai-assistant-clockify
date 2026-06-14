# Claude Code Workflow feature — best practices (for authoring `.claude/workflows/*.js`)

> A concise, opinionated synthesis for writing **Claude Code Workflow scripts**
> (the `Workflow` tool / `.claude/workflows/*.js` orchestration assets). Grounded
> in the Workflow tool contract and this repo's two existing workflows
> (`full-angle-audit.js`, `dogfood-and-fix.js`). Read before editing
> `implement-chat-history-switcher.js`.

## What a workflow is (and isn't)

A workflow is a **deterministic JavaScript orchestrator** that spawns subagents
and threads their structured results. The *control flow* (loops, conditionals,
fan-out, sequencing) is code; the *judgment* lives in the subagents. Use one when
you want structure a single agent can't hold: comprehensive fan-out, adversarial
verification, or scale (migrations, audits, multi-phase builds).

It runs in the **background** — the `Workflow` tool returns immediately and a
task-notification fires on completion. Watch progress with `/workflows`.

> **Opt-in only.** A workflow can spawn many agents and spend many tokens. Only
> launch when the user explicitly asked for multi-agent orchestration (or said
> "ultracode"/"use a workflow"/named a saved workflow). Otherwise, use a single
> `Agent` call or just do the work.

## The script contract (hard rules)

1. **Start with a pure-literal `meta`**: `{ name, description, whenToUse?, phases }`.
   No variables, calls, or interpolation in `meta`. `phases[].title` must match
   the `phase('…')` calls in the body exactly.
2. **Plain JavaScript, not TypeScript** — no type annotations/interfaces/generics
   (they fail to parse).
3. **No `Date.now()` / `Math.random()` / arg-less `new Date()`** — they throw
   (they would break resume). Pass timestamps via `args`; vary by index for
   "randomness"; read SHAs/clocks from inside agents.
4. **Pass `script` inline** to the `Workflow` tool (don't `Write` it first to run
   it) — but DO persist iterations: every invocation writes the script to the
   session dir and returns its path; re-run with `{ scriptPath }` after editing.
5. **Self-contained subagent prompts** — agents do NOT inherit the orchestrator's
   context. Inline the repo path, the rules, and the exact task in every prompt.

## The body API (what you actually call)

- `agent(prompt, { schema?, phase?, label?, model?, agentType?, isolation? })` →
  the agent's structured object (when `schema` given) or final text. Returns
  `null` if the agent dies/skips — `.filter(Boolean)`.
- `parallel(thunks)` → barrier; awaits all; a throwing thunk becomes `null`.
- `pipeline(items, ...stages)` → per-item stages with NO barrier (default for
  multi-stage independent work).
- `phase(title)` / `log(msg)` — progress UI.
- `args` — the value passed to the `Workflow` tool (parameterize named workflows).
- `budget` — token target controls (`budget.total`, `budget.remaining()`).
- `workflow(name|{scriptPath}, args)` — run another workflow inline (one level).

Concurrency is capped (~`min(16, cores-2)`); lifetime cap 1000 agents; a single
`parallel`/`pipeline` call ≤ 4096 items.

## Choosing the shape

| Goal | Shape |
|------|-------|
| Independent fan-out (audit dimensions, dogfood themes) | `parallel(...)` — see `dogfood-and-fix.js` Dogfood phase |
| Multi-stage per item, no cross-item dependency | `pipeline(items, stageA, stageB)` |
| **Dependent, sequential build (phase N needs N-1's commit)** | a **plain `for` loop** threading state — see below |
| Find → dedup-across-all → verify | `parallel` (barrier) only where the dedup genuinely needs all results |
| Loop until dry / until budget | `while` with a counter / `budget.remaining()` |

A **dependent feature build is sequential, not parallel**: each phase commits and
the next phase preconditions on that commit. Don't fan it out.

## The autonomous-implementation pattern (this repo's proven shape)

From `dogfood-and-fix.js`, generalized for a feature build:

1. **Preflight gate** — one agent verifies the starting state (clean tree,
   `headSha`, `npm run verify` currently green, the right branch). Abort the whole
   run if it fails. Capture `headSha`.
2. **Per-phase agent**, each with:
   - **PRECONDITIONS**: clean tree, `HEAD === expectedHead` (the prior phase's
     commit). If violated → `blocked` + `preconditionFailed`, do nothing.
   - **PROTOCOL**: read the plan section → **RED** (failing test first, run only
     that file, paste the failure) → **GREEN** (minimal change) → **GATE**
     (`npm run verify` judged by **exit code, never `verify | grep`**, plus
     `npm run cycles` = 0) → **ONE** focused Conventional-Commit. Never stage
     `.env*`, `data/`, `eval-results/`.
   - **ABORTS**: verify red twice → `git reset --hard <expectedHead>`,
     `status="blocked"`. Touching a forbidden area (here: session TTL, the
     `src/harness/*` safety boundary) → `git reset --hard`,
     `status="blocked_safety"` — never weaken a safety boundary to pass.
   - **Structured result** (`PHASE_SCHEMA`): `{ phaseId, status, commitSha,
     testFile, touchedPaths, attempts, treeClean, notes }`.
3. **Sequential loop** threading `headSha`: on a successful commit, advance
   `headSha = result.commitSha`; **halt** on precondition failure, safety abort,
   or two consecutive blocks (don't let a wedged build thrash).
4. **Final verify** agent — full gate + cycles + a check that the critical test
   (here: the IDOR guard) exists and passes; optional live smoke.
5. **Report** — return a summary object (start/end SHAs, per-phase status, gate).

## Safety & hygiene for autonomous code-writing workflows

- **Branch, don't touch protected `main`.** Create a feature branch in preflight;
  commit there; **never push or open a PR** (leave that to the human).
- **Judge gates by exit code.** `npm run verify > log 2>&1; echo EXIT=$?` — a
  `verify | grep` pipeline once masked a real `tsc` failure in this repo.
- **TDD is the contract**, not a suggestion — a phase that can't write a failing
  test first probably isn't a real, verifiable change.
- **Fence the dangerous edges in the prompt.** State explicitly what must NOT
  change (here: `DEFAULT_SESSION_TTL_MS`, expiry checks, `src/harness/*`), with a
  `blocked_safety` abort if the agent is tempted — an autonomous agent should
  refuse a security decision, not make one.
- **Idempotent re-runs.** Because `meta`/SHAs gate each phase, re-running the
  workflow resumes cleanly (completed phases are already committed; the loop
  preconditions skip-or-continue). Keep the script free of wall-clock/random so
  the journal-based resume works.
- **Keep agents from leaking secrets** — a `RULES` block that says "never print
  `.env*`, never stage secrets/`data/`/`eval-results/`," repeated in every prompt.

## Repo specifics to inline in every agent prompt here

- Repo: `/Users/15x/Downloads/WORKING/addons-me/ai-assistant-addon`.
- Gate: `npm run verify` (type-check + vitest + build) **and** `npm run cycles`
  (madge, 0). Run one test file with `npx vitest run <path>`.
- Read `CLAUDE.md` "Engineering rules" + "Safety & planner invariants", and
  `plans/007-…INVESTIGATION.md` + `plans/008-…IMPLEMENTATION.md` before coding.
- Conventional Commits; small focused commits; ESM `.js` import suffixes; UI text
  via `textContent` only.
