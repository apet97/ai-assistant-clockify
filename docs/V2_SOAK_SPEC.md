# V2 production soak — the specification

**Status:** written at Phase D task D6 (2026-07-31). The soak has NOT started. Every
threshold quoted below was read from `DEPLOYMENT.md` "Required alerts" and from the
exported constants that section names; none was invented here.

This document exists because four documents require a soak and none defined one:
`CLAUDE.md`, `MARKETPLACE_READINESS.md`, `README.md`, and
[`docs/V2_CLOSURE_ACCEPTANCE.md`](./V2_CLOSURE_ACCEPTANCE.md). A fifth,
[`docs/V1_RETIREMENT_SEQUENCE.md`](./V1_RETIREMENT_SEQUENCE.md), makes this file's
completion its hard entry gate — so until this spec existed the v1 retirement sequence
was unstartable by construction.

---

## 1. What this is, and what it is not

The soak is an **observation window on production**, not a test run. Nothing is
executed against production for the soak's sake: the operator configures the alerts
`DEPLOYMENT.md` already specifies, lets real admin traffic run against the deployed v2
candidate, and records what the log plane did or did not say.

It is **not** a substitute for any engineering gate. `verify`, the browser matrices, the
credentialed evals, `live:v2-full` + `live:sweep`, and the candidate-bound backup/restore
drill are all *prerequisites*, not soak content. A soak over a candidate whose engineering
gates are open proves nothing.

It is also **not** a performance benchmark. This repository has no released v2 performance
thresholds — `scripts/evidence/v2-private-production-release-evidence.ts` refuses to
pretend otherwise — so no latency or throughput number is an abort criterion here.

---

## 2. Entry gate — what must be true before the clock starts

The soak clock does not start until ALL of the following are true. Each is an observable
fact, not a judgement.

1. **Deploy identity verified on the exact candidate.** The deployed `/version` payload
   satisfies `verifyDeployedV2Engine` (`scripts/evidence/v2-deployed-engine.ts`):
   `releaseSha` exactly equals the candidate SHA, `modelConfiguration.assistantEngine`
   is `"v2"`, and `buildHash` / `serverArtifactSha256` are present and well-formed.
   `/live`, `/health`, and `/manifest` each answer `200` (`DEPLOYMENT.md`, "5. Verify the
   deploy"). This is the release-run step the executor plan labels E5; that label exists
   only in the plan, so the gate is stated here by content.
2. **The deployment came through the checked transaction.** `npm run
   deploy:private-production` inside `DEPLOYMENT.md`'s "Release-candidate checked
   transaction", never a bare `railway up` from a working tree.
3. **A written, executable v1 rollback procedure exists — BLOCKING, and not satisfied at
   this commit.** This is NOT the `ROLLBACK_RELEASE_SHA` / `ROLLBACK_SOURCE_DIR` pair in
   `DEPLOYMENT.md`'s deploy transaction. Those are that transaction's own UNDO and are
   pinned by `test "$ROLLBACK_RELEASE_SHA" = "$SERVING_RELEASE_SHA"`, so during a v2 soak
   they necessarily name the **v2** tree and can never name v1; ticking them establishes
   nothing about v1 reachability. What must exist is the D9 v2 runbook walking
   `planSignedFullV1Rollback` (`scripts/cutover-transaction.ts`) plus ADR 003's
   stale-installation-row clearance, naming the recorded v1 variable set, v1 source, v1
   artifact hash, and v1 database path. See §4 for why the obvious substitute does not
   execute. **Until D9 lands this item cannot be satisfied and the soak may not start.**
4. **The ten alerts are configured and proven to reach a human.** Every match string in
   §5's table is configured as a log-match alert, and at least one of them has been
   observed firing end to end (the `cause=draining` line the deploy itself produces
   satisfies this). An alert nobody receives is worse than no alert: the operator
   configures it, it never fires, and the silence reads as health.
   **One criterion cannot be a log-match alert at all:** §7.1 criterion 6 is the ABSENCE
   of `[operator] event=health_snapshot`, and no substring alert fires on a line that was
   never written. This repository ships no watchdog and cannot supply one. Before the
   clock starts the operator must either configure a platform absence/no-data alert on
   that string, if the log plane offers one, or record an explicit manual spot-check
   cadence. Whichever is chosen is named in §9's `heartbeatObserved`; "we would have
   noticed" is not one of the options.
5. **Log access is answered.** `DEPLOYMENT.md` carries an explicit **OWNER VERIFICATION
   REQUIRED** item on the log plane: who can read production logs, whether that path is
   authenticated/MFA'd and audited, and how long a line persists. Items (1)–(3) there must
   be recorded before the clock starts, because the entire watch list is delivered through
   that plane and a retention shorter than the window silently destroys the evidence.

**Restart rule.** The window is served on ONE candidate. Any deployment during the window
whose `/version.releaseSha` differs from the recorded `candidateSha` **restarts the 7-day
clock at zero**. This is not a stylistic preference: `docs/V1_RETIREMENT_SEQUENCE.md`
entry-gate item 3 requires that production served v2 "for the full soak window on the
exact retirement candidate", so a mid-window redeploy makes the record untrue rather than
merely shorter.

---

## 3. Duration

**The soak window is 7 consecutive days** — 7 × 24 h of wall-clock time from the instant
the §2 entry gate is satisfied, recorded as an ISO-8601 UTC instant.

Owner decision, 2026-07-31. Chosen over a 72-hour option and a 14-day option because seven
days crosses one full weekly usage cycle: a workspace's Monday morning, its mid-week peak,
and its weekend idle all land inside one window. A shorter window can end without ever
having seen the retention prune fail on a busy day or the fleet go quiet.

An operator can tell the soak has PASSED when, and only when, all four are true:

- the recorded window start instant plus 7 × 24 h has elapsed;
- `/version` still reports the same `releaseSha` on `assistantEngine: "v2"` that the entry
  gate recorded (no redeploy restarted the clock);
- no §7 immediate-abort criterion fired at any point in the window; and
- the §9 declaration artifact exists with all of its named inputs filled.

Anything less is an incomplete soak, not a short one.

---

## 4. The rollback deadline

**Once any §7 immediate-abort criterion fires, rollback to the v1 engine must be COMPLETE
within 24 hours.** Owner decision, 2026-07-31, chosen over a 12-hour option and a 48-hour
option because the 24-hour deadline is short enough to be a real commitment and long
enough to survive one overnight.

Both endpoints are observable:

- **The clock starts** at the timestamp of the FIRST log line matching an immediate-abort
  criterion — not when a human noticed it. If the line is discovered late, the deadline
  was already running; record the line's own timestamp.
- **Rollback is COMPLETE** when production `/version` reports
  `modelConfiguration.assistantEngine` equal to `"v1"` on the v1 rollback tree, and
  `/live`, `/health`, and `/manifest` each answer `200`. A variable flipped in the Railway
  dashboard with no redeploy, or a redeploy still reporting `"v2"`, is not complete.

**Two of the thirteen immediate criteria produce no log line, so the rule above does not
reach them. Their start instants are defined here rather than left to interpretation:**

- **Criterion 6 (heartbeat ABSENCE)** has no line by definition. Its clock starts at the
  timestamp of the LAST `[operator] event=health_snapshot` line before the gap, plus two
  `OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS` intervals — the instant the gap became
  abort-worthy. But see §2 item 4: no log-match alert can fire on absence, so unless the
  operator configured a platform no-data alert, this gap is found by manual spot-check or
  not until declaration time. **Found at declaration time, it is not an abort with a
  running clock — the soak has simply FAILED**, because the window was unobserved for that
  span and nothing can retroactively establish what happened in it. The correct outcome is
  a failed declaration and an owner decision, not a backdated breach of the deadline.
- **Criterion 13 (admin-reported data-integrity incident)** is out of band by
  construction. Its clock starts at the timestamp of the admin's report as received, and
  the report itself is recorded in §9's `abortCriteriaVerdict`.

A rollback that finishes after the deadline is LATE. Record it as late in the declaration
artifact rather than adjusting the start instant; the deadline exists to be measured
against, and a soak that reports a late rollback is more useful than one that reports none.

**What the deadline actually commits to — and why the obvious path is not it.**

`DEPLOYMENT.md`'s checked transaction, run literally with `SELECTED_ASSISTANT_ENGINE` at
its `v1` default, **throws before any Railway mutation**. Its export block sets
`SELECTED_DATABASE_PATH="/data/ai-assistant.sqlite"` with
`SELECTED_DATABASE_PATH_DISPOSITION="existing_expected"`, and production serves
`/data/ai-assistant-v2.sqlite`, so `scripts/deploy-private-production.ts` refuses
`existing_expected` (that is not the deployed path). Switching to `new_unused` is refused
too, because the retained v1 database is nonempty and carries no fresh-cutover marker
(`src/db/fresh-boundary.ts`). This is not a reading of mine:
`docs/marketplace/03-operations-evidence-rollback-package.md` states it in its own scope
banner — "**This page is not an executable v1 rollback either.**"

The real path is **`planSignedFullV1Rollback`** (`scripts/cutover-transaction.ts`): a
recorded signature, the v1 source, the v1 restore-artifact hash, all eight rollback
variables, and the **v1 database** — restoring v1 code while leaving the v2 database
selected is refused explicitly, because v1 would be serving a database it never wrote —
plus ADR 003's `clearsStaleInstallation` step, since a restored v1 database still holds
the pre-outage installation row. It is **owner-planned work against a plan object**, not
a read-through of any page.

**BLOCKING PREREQUISITE.** No document currently walks an operator through that plan.
`docs/marketplace/03-operations-v2-runbook.md`, which the v1 banner redirects to, **does
not exist at this commit** (it is task D9). A 24-hour deadline against an unwritten
procedure is not a commitment, it is a wish. **D9 must land before the soak clock
starts** — which is why §2 carries it as entry-gate item 3 rather than as a footnote
here.

---

## 5. The watch list

One row per `DEPLOYMENT.md` "Required alerts" row. The **match string** column is the
exact substring the code emits; it must stay set-equal to that table, and
`tests/unit/release-operations-contract.test.ts` fails if it drifts. The **alert
threshold** column is owned by the code and that runbook. The **soak verdict** column is
owned by THIS document — it says what an operator does with the line during the window,
and §7 is its normative statement.

| # | Watch | Match string | Alert threshold (owned by the code) | Soak verdict |
|---|---|---|---|---|
| 1 | Readiness probe failing (`503`) | `[readiness] event=not_ready` | No count. Once per cause; OPEN until `[readiness] event=ready_recovered`, which is emitted only by the SAME process | INVESTIGATE `cause=draining` matched to a known deploy or platform restart — a drain NEVER produces a recovery line, so its absence is not a signal (see §6). IMMEDIATE ABORT for any other cause not cleared by a same-process `ready_recovered` within one snapshot interval |
| 2 | Fatal or draining exit | `received — draining`, `unhandledRejection:`, `uncaughtException:`, `startup failed:` | No count. Every occurrence | IMMEDIATE ABORT on any of the three fatal strings. INVESTIGATE a draining line that pairs with a known redeploy — and note the redeploy restarts the clock (§2) |
| 3 | Retention backlog, or repeated prune failure | `[retention] event=prune_backlog_started`, `[retention] event=prune_failing_repeatedly` | `RETENTION_PRUNE_FAILURE_THRESHOLD` = 3 consecutive failed hourly sweeps. Backlog once per crossing | INVESTIGATE a backlog that opens and later clears. IMMEDIATE ABORT on `prune_failing_repeatedly`, or on a backlog still open at the end of the window |
| 4 | SQLite `BUSY`/`FULL`/read-only | `[storage] event=sqlite_unavailable` | No count. Every occurrence at `site=request`; once per readiness crossing at `site=readiness` | IMMEDIATE ABORT at `kind=full` or `kind=readonly`. INVESTIGATE an isolated `kind=busy`; ABORT if it recurs on more than one calendar day |
| 5 | Operation `outcome_unknown` | `[write-outcome] event=outcome_unknown` | No count. Every settlement | IMMEDIATE ABORT. The string appearing AT ALL means a real Clockify write settled ambiguously under v2 |
| 6 | Sustained Clockify `429`/5xx | `[clockify-host] event=host_throttled_sustained` | `SUSTAINED_HOST_WINDOW_THRESHOLD` = 12 failures inside `SUSTAINED_HOST_WINDOW_MS` = 60000 ms (`trigger=window`); `SUSTAINED_HOST_CONSECUTIVE_THRESHOLD` = 4 consecutive (`trigger=consecutive`) | INVESTIGATE either trigger — a Clockify-side outage is not a v2 defect. IMMEDIATE ABORT only if it coincides with row 5 or with a `partial` result an operator can see |
| 7 | Model-provider failure | `provider_http_error status=` | No count. Every non-2xx; a ` retry=1` suffix marks the retried attempt | INVESTIGATE. Provider 429/5xx is expected background noise. ABORT only when it coincides with row 5 |
| 8 | Artifact oversize reject | `[storage] event=artifact_oversize_rejected` | No count. Every occurrence | INVESTIGATE at `site=download` (the expected site). IMMEDIATE ABORT at `site=export` or `site=persist` — either means something upstream is not what it is assumed to be |
| 9 | Repeated installation-token rejection | `[install-authority] event=token_rejected_suspect` | `TOKEN_REJECTION_SUSPECT_THRESHOLD` = 3 rejections per streak, per workspace; resets on an accepted response | INVESTIGATE. Retiring the row is a deliberate operator act and authority is never changed from a wire signal, so this never aborts on its own |
| 10 | Fleet health heartbeat and levels | `[operator] event=health_snapshot`, `[operator] event=snapshot_unavailable` | Unconditional, every `OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS` = 900000 ms plus once at boot | IMMEDIATE ABORT on `stalled` above 0, on `outcome_unknown_unreconciled` above 0, on `retention_backlog=1`, on `in_flight` not equal to the sum of the five `phase_` fields, or on the heartbeat going absent (§7). INVESTIGATE a rising `outcome_unknown` and the flow fields |

Thresholds restated in the exact form this repository pins elsewhere. Each is imported
from `src/` by the contract test, so a constant change fails the suite rather than rotting
here:

- `RETENTION_PRUNE_FAILURE_THRESHOLD` = 3
- `SUSTAINED_HOST_WINDOW_THRESHOLD` = 12
- `SUSTAINED_HOST_WINDOW_MS` = 60000
- `SUSTAINED_HOST_CONSECUTIVE_THRESHOLD` = 4
- `TOKEN_REJECTION_SUSPECT_THRESHOLD` = 3
- `OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS` = 900000

Two of those six are values `DEPLOYMENT.md` does NOT state in the
`` `NAME` = <number> `` form its own constants block uses, so this spec is their only
document: `TOKEN_REJECTION_SUSPECT_THRESHOLD` (row 9 says "once per streak" without a
number, from `src/clockify/token-rejection-monitor.ts`) and
`OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS` (row 10 says "every 15 minutes" in words, from
`src/operator-health.ts`). Both are pinned by import here, and the contract test also
asserts the runbook still does NOT state them — so if it ever does, this sentence fails
rather than quietly becoming false.

Over a 7-day window the row-10 heartbeat should produce on the order of 672 lines
(7 × 24 × 4, from `OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS`) plus one per boot. Treat that as
a sanity floor, never an equality: `setInterval` drifts, and each restart adds a boot line.

---

## 6. What this watch list does NOT see

A watch list read as complete is a watch list that will miss things. Most limits below are
already recorded in `DEPLOYMENT.md` "Required alerts" (its "Known limits" list and the
paragraph on what the contract pin proves); they are carried here because a soak is exactly
the window in which they matter. Three are NOT in that runbook and are sourced here
instead: the silent force-exit path is read from `src/server.ts`, the unreachable
drain-recovery line from `src/readiness-alerts.ts` + `src/server.ts`, and the last bullet
is this document's own observation. Every other bullet, including the un-asserted timer
creation, is stated in the runbook. Each says where it came from.

- **`[readiness] event=ready_recovered` cannot cross a process boundary, so a drain has
  no recovery line at all.** `createReadinessAlertMonitor` (`src/readiness-alerts.ts`)
  holds `openCause` in memory and `ready()` returns SILENTLY when it is `undefined`.
  `src/server.ts` creates exactly one monitor per process; the drain path sets readiness
  false and the process then exits, so it never calls `ready()` with a cause still open,
  and the REPLACEMENT process starts with `openCause === undefined` and therefore emits
  nothing on its healthy probes. Consequence: a `cause=draining` line is NEVER followed by
  `ready_recovered`, and any criterion phrased as "a drain that does not recover" would
  fire on **every routine deploy**. Recovery is observable in-log only in-process, for a
  storage cause that clears; a drain's resolution must be read from `/health` answering
  `200` again. This one is not in the runbook — row 1's firing rule says the condition
  "stays OPEN until `ready_recovered`" without noting that the drain case can never
  reach it.

- **Row 3's streak is per process.** The sweep runs hourly, so a container restarting more
  often than about two hours can never reach three consecutive failures and
  `prune_failing_repeatedly` will not fire for a persistently broken prune on a
  crash-looping instance. Rows 1 and 4 are the cover for that specific case (a full or
  read-only volume), because they fire on the first occurrence.
- **Row 6 counts only ANSWERED responses.** A Clockify outage that refuses the connection
  or fails DNS produces no status at all and generates zero observations, so this alert
  stays silent through a total connection-level outage. Rows 5 and 7 and the ordinary error
  path are what surface it.
- **Row 6 needs volume.** A workspace with low traffic AND only partial degradation may
  never accumulate 12 failures inside 60 s while its successes keep the fast-trip from
  firing. That case is undetected. A soak on a quiet workspace is therefore NOT evidence
  that host degradation would have been caught.
- **Row 6's latches are per process and per workspace, in memory.** A restart clears both,
  so the next outage after a restart alerts again — and, symmetrically, a restart erases
  the fact that an outage was already open.
- **Three of row 2's four strings are pinned by SOURCE only.** `unhandledRejection:`,
  `uncaughtException:` and `startup failed:` are literal arguments to `console.error`
  inside `process.once(...)` handlers and the module-scope `start().catch`. The contract
  test proves the string is emitted code rather than prose; it does NOT prove the handler
  runs. A soak that sees none of these has not proven they work.
- **The force-exit path is silent.** `createShutdownHandler` (`src/server.ts`) starts a
  10 s force timer and, on expiry, calls `finish(1)` — which closes the store and exits 1
  emitting NO line. The only log line in the whole teardown is the `received — draining`
  one at the start. So a clean drain and a force-exit that dropped in-flight requests look
  IDENTICAL in the log plane. During the soak, a draining line must be correlated with the
  platform's own exit code; the log alone cannot tell them apart.
- **Row 10's LEVEL fields are instantaneous.** `in_flight`, the five `phase_`, `stalled`,
  both `outcome_unknown` fields and `retention_backlog` answer only what was true at the
  instant the snapshot ran. A stall that starts and clears inside one 15-minute interval
  leaves no trace at all.
- **Row 10's windows do not tile.** `setInterval` drifts by however long the previous
  snapshot and the rest of the event loop took, so consecutive windows overlap or leave a
  gap and an event landing in a gap is counted by NO line. Never sum flow fields across
  lines to produce a soak total.
- **Row 10's first line after a restart is distorted.** Store construction stamps every
  crash-orphaned run's synthetic failure with the CURRENT time, so the boot snapshot
  attributes every historical orphan to the last 15 minutes. It is a real signal ("this
  restart found N stranded runs") but it is not a rate.
- **Row 10's `retention_backlog` answers "did the LAST RECORDED sweep finish", not "did a
  sweep happen".** It reads 0 when no sweep record exists at all. "The prune is not
  running" is row 3's job, and row 3 has the per-process limit above — so a soak can be
  blind to a prune that never ran on a restarting instance.
- **Nothing asserts at BOOT that the timers were created.** The retention prune timer and
  the row-10 snapshot timer are both created inside `start()`, which is not reachable from
  a test; `createShutdownHandler` clearing them is pinned, their creation is not. A
  wholesale removal of a factory call, or a monitor that does nothing, would be silent.
  The only defence during the soak is the heartbeat-absence criterion in §7 — which is why
  absence of the heartbeat is itself treated as a signal.
- **The two most load-bearing rows cannot always name a workspace.** Row 10 carries NO
  workspace dimension at all — deliberately, because it is the one line aggregated across
  tenants and a per-workspace breakdown would re-introduce exactly the cross-tenant
  correlation the aggregate exists to avoid. Row 5's line omits `workspace=` wherever no
  session secret is in scope: the harness settlement seam, and the restart-recovery
  aggregate, which spans every workspace by construction
  (`src/log-outcome-unknown.ts`). That covers the headline criterion (§7.1 criterion 1)
  and four of the row-10 field criteria (2–5). Those lines establish THAT an ambiguous
  write or a stalled run happened and WHICH action — not WHERE. The operation id
  correlates lines to each other and is **not** an operator lookup key:
  `GET /api/operation-runs/:operationId` requires a session and scopes on workspace +
  admin + session, so it 404s for anyone but the causing admin. Plan the triage
  accordingly — §9's per-row disposition can record what was seen and what was done, but
  it cannot always name a workspace, and demanding one would push an operator toward
  guessing.
- **Log access and retention are unverified properties of the platform.** Per
  `DEPLOYMENT.md`'s **OWNER VERIFICATION REQUIRED** block, nothing in this repository
  establishes who can read production logs or how long a line persists. If retention is
  shorter than 7 days, the early part of the window is unobservable after the fact and the
  declaration artifact must say so rather than report zero.
- **No alert covers wrong-but-successful behaviour.** Every row above fires on a failure
  signal. An admin receiving a confidently wrong answer, a preview that misdescribes its
  write, or a policy denial that should have been an allow produces no line anywhere. The
  soak is a stability window, not a correctness window; correctness is the evals' and the
  browser matrices' job, and a clean soak says nothing about it.

---

## 7. Abort criteria

Stated as observable conditions. "Something looks wrong" is not a criterion.

### 7.1 IMMEDIATE ABORT — start the §4 rollback clock

Any ONE of these, once:

1. `[write-outcome] event=outcome_unknown` appears at all. (The same substring also
   catches the restart-recovery aggregate `[write-outcome] event=outcome_unknown_recovered`
   — that variant is also an immediate abort, because it means a restart found ambiguous
   effects.)
2. A row-10 `[operator] event=health_snapshot` line carries `stalled` above 0.
3. A row-10 line carries `outcome_unknown_unreconciled` above 0.
4. A row-10 line carries `in_flight` not equal to the sum of its five `phase_` fields.
5. A row-10 line carries `retention_backlog=1`. (This is `DEPLOYMENT.md`'s own page rule
   for the field, kept unsoftened: the field answers "did the LAST RECORDED sweep finish",
   so a 1 is already a completed failure, not a transient.)
6. No `[operator] event=health_snapshot` line for more than TWO consecutive
   `OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS` intervals (that is, >30 minutes), outside a
   known restart. This spec chooses two rather than one: one missed interval is ordinary
   scheduler drift or a restart, both documented; two consecutive means the timer is gone,
   and nothing else in the system would report that. **This criterion is an ABSENCE and
   cannot be a log-match alert** — see §2 item 4 for what must be configured instead, and
   §4 for its clock start and for why finding it only at declaration time is a failed
   soak rather than a late rollback.
7. `[operator] event=snapshot_unavailable` appears twice or more — the read itself is
   throwing, so every row-10 criterion above is unobservable.
8. `[storage] event=sqlite_unavailable` with `kind=full` or `kind=readonly`, once; or
   `kind=busy` on more than one calendar day of the window.
9. `[retention] event=prune_failing_repeatedly` appears at all.
10. `unhandledRejection:`, `uncaughtException:`, or `startup failed:` appears at all.
11. `[readiness] event=not_ready` with any `cause` other than `draining` — that is
    `sqlite_busy`, `sqlite_full`, `sqlite_readonly`, or `storage_error` — where the SAME
    process does not go on to emit `[readiness] event=ready_recovered` within one
    `OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS`. That bound is this spec's choice, derived
    rather than guessed: the heartbeat is the only periodic signal in the system, so one
    snapshot interval is the finest resolution at which "still open at the next
    observation" is answerable. **A `cause=draining` line is explicitly NOT this
    criterion**, and its missing recovery line is not evidence of anything — see §7.2
    criterion 1 and the §6 limit on why `ready_recovered` cannot cross a restart.
12. `[storage] event=artifact_oversize_rejected` at `site=export` or `site=persist`.
13. Any admin-reported data-integrity incident in the workspace — a duplicated write, a
    write the admin did not confirm, or a confirmed write that did not happen. This is the
    one criterion that does not come from the log plane, and it overrides a clean log.

### 7.2 INVESTIGATE, but do not abort

Record each occurrence in the declaration artifact with a one-line disposition. Continue
the window unless the investigation promotes it into §7.1.

1. `[readiness] event=not_ready cause=draining` correlated with a known deploy or
   platform restart, where `/health` answers `200` again once the replacement process is
   up. Resolution is read from `/health`, NOT from the log: there is no
   `[readiness] event=ready_recovered` line for a drain and there never can be (§6).
2. `received — draining` correlated with a known redeploy. Note that a redeploy of a
   different `releaseSha` restarts the 7-day clock (§2).
3. `[retention] event=prune_backlog_started` that is later followed by
   `[retention] event=prune_backlog_cleared`.
4. `[clockify-host] event=host_throttled_sustained` at either trigger, with no row-5 line
   and no admin-visible `partial` result.
5. `provider_http_error status=` at any rate, with no row-5 line.
6. `[storage] event=artifact_oversize_rejected` at `site=download`.
7. `[install-authority] event=token_rejected_suspect`.
8. A rising `outcome_unknown` trend on row 10 with no new row-5 line — it is a STANDING
   backlog whose only drop paths are a restart's reconciliation and 30-day retention, so a
   flat nonzero value is history, not a new event.
9. `runs_failed` or the `budget_denied_` fields moving beside `runs_started`. These are
   windowed flows, not a ledger, and are not a strict ratio.

---

## 8. Rollback, and the interlock with v1 retirement

The 24-hour deadline in §4 is a promise that the v1 engine is still reachable. Three
consequences, all of which `docs/V1_RETIREMENT_SEQUENCE.md` must be read together with:

- **Its entry-gate item 2 may not execute before or during the soak.** That item
  supersedes `DEPLOYMENT.md`'s v1-rollback block, and the block — however unexecutable it
  is today (§4) — is still the only written v1-return material in the tree until D9. The
  rewrite therefore belongs strictly AFTER the soak declaration, because the declaration
  is what unlocks the entry gate the rewrite lives inside. *(Flagged, not resolved: the
  retirement document is internally inconsistent about where that rewrite sits. Its
  entry-gate item 2 says the block "must be rewritten BEFORE step 1 below, not after",
  while its step 1 is titled "Rewrite `DEPLOYMENT.md`'s rollback block (entry-gate item
  2)". This spec takes no position on that internal ordering and does not alter it; the
  only thing it requires is that the rewrite does not happen before or during the soak.
  Resolving the contradiction belongs to the retirement document's owner.)*
- **Its entry-gate item 3 is satisfied by this spec's §9 artifact**, and only by an
  artifact whose `candidateSha` equals the SHA production served for the whole window.
- **Its step 8 forfeits rollback.** Once `ASSISTANT_ENGINE` collapses to a single value
  there is no supported path back without a revert-and-redeploy. The soak is the last
  window in which rollback is cheap; that is what it is for.

---

## 9. The declaration artifact — named inputs

A soak is declared passed by an artifact, never by assertion. The artifact follows the
convention every record under `evidence/` already uses: `schemaVersion`, `kind`,
`conclusion`, an exact `candidateSha`, an `observedAt` instant, closed objects, and
deterministic JSON with no secret, no token, no raw workspace or admin id, and no
admin-authored text.

Location: `evidence/soak/v2-soak-declaration-<candidateSha>.json`, mirroring the
`evidence/eval/v2-*-<sha>.json` naming already in the tree.

**No builder script exists for this artifact and this document does not invent one.** The
record is assembled by the operator. If one is written later it must be a sibling under
`scripts/evidence/v2-*.ts` — never an edit of a v1 validator, which is rollback evidence
and stays untouched.

Required named inputs. An artifact missing any one of these is not a declaration:

1. `candidateSha` — the full 40-hex source candidate.
2. `deployIdentity` — the `releaseSha`, `buildHash`, `serverArtifactSha256`, and
   `modelConfiguration.assistantEngine` read from the deployed `/version` at the entry
   gate, exactly the subset `verifyDeployedV2Engine` binds; plus the `200` results for
   `/live`, `/health`, and `/manifest`.
3. `windowStart` / `windowEnd` — ISO-8601 UTC instants, with `windowEnd - windowStart` at
   least 7 × 24 h.
4. `deploymentLedger` — every production deployment observed inside the window with the
   `releaseSha` each reported. Exactly one distinct SHA, equal to `candidateSha`, or the
   clock restarted and the window is not this window.
5. `watchListResults` — one entry per row 1–10 of §5, each carrying the row number, the
   exact match strings watched, the number of matching lines observed, and a disposition.
   A row with zero observations must say zero explicitly; an omitted row reads as
   unobserved, which is a different claim. A disposition names a workspace only where the
   line carried one: rows 5 and 10 frequently cannot be attributed to a workspace at all
   (§6), and an invented attribution is worse than "not attributable".
6. `heartbeatObserved` — the count of `[operator] event=health_snapshot` lines seen across
   the window, the longest observed gap between consecutive lines, and **which absence
   mechanism §2 item 4 selected** (a platform no-data alert, or a manual spot-check
   cadence with its interval). Without that field §7.1 criterion 6 is retrospective only.
7. `abortCriteriaVerdict` — one verdict per §7.1 criterion (13 entries) and per §7.2
   criterion (9 entries): fired or did not fire, with the disposition of each that fired.
8. `logPlaneAccess` — the answers to `DEPLOYMENT.md`'s three **OWNER VERIFICATION
   REQUIRED** items, including the observed log retention. If retention is shorter than
   the window, the artifact must record which part of the window is unobservable rather
   than reporting zero occurrences for it.
9. `knownBlindSpots` — an explicit acknowledgement that §6's limits were understood, and
   in particular whether traffic volume was high enough for row 6 to be meaningful.
10. `rollback` — either the literal statement **"no rollback required"**, or, if a
    criterion fired, the firing line's timestamp, the completion timestamp, the elapsed
    hours, and whether the 24-hour deadline was met.
11. `conclusion` — `"passed"` only when §3's four conditions all hold. Any other state is
    not a soak declaration.

---

## 10. Anchors

Every citation in this document is by section heading or exported symbol, never by line
number, so an edit above it cannot silently retarget it.

- `DEPLOYMENT.md` — "Required alerts", "5. Verify the deploy", "Release-candidate checked
  transaction".
- `src/retention-alerts.ts`, `src/clockify/host-throttle-monitor.ts`,
  `src/clockify/token-rejection-monitor.ts`, `src/operator-health.ts`, `src/server.ts`,
  `src/readiness-alerts.ts`, `src/log-outcome-unknown.ts`.
- `scripts/evidence/v2-deployed-engine.ts` — `verifyDeployedV2Engine`;
  `scripts/cutover-transaction.ts` — `planSignedFullV1Rollback`.

Numeric prose in this document obeys two closed rules the contract test enforces by
stripping every permitted form and requiring nothing to remain, so a value cannot drift at
one mention while staying correct at another, and no new phrasing can escape the sweep:

- every hour quantity is `within <N> hours` or `<N>-hour deadline` — both pinned to §4's
  deadline — or `<N>-hour option`, a rejected alternative that is deliberately
  unconstrained; and
- every day quantity is `<N> consecutive days`, `<N> days`, or
  `<N>-day soak`/`clock`/`window` — all pinned to §3's window — or `<N>-day option`, a
  rejected alternative, or `<N>-day retention`, which names a system retention period and
  is not this document's number.
- [`docs/V1_RETIREMENT_SEQUENCE.md`](./V1_RETIREMENT_SEQUENCE.md) — hard entry gate items
  1–3 and step 8.
- `tests/unit/release-operations-contract.test.ts` — the contract that keeps §5's match
  strings set-equal to `DEPLOYMENT.md`'s table, enforces the two numeric rules above, and
  keeps the window value equal across the four documents that reference this spec.
