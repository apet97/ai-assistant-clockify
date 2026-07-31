# V1 retirement — the dependency-ordered sequence

**Status:** written at Phase C task C12 (2026-07-31). NOT executable yet — see the
entry gate. Every line count and citation below was measured against the tree at
this commit, not copied from a plan.

---

## ⛔ HARD ENTRY GATE — none of this may begin until ALL are true

1. **The soak declared in `docs/V2_SOAK_SPEC.md` is complete**, with its declaration
   artifact recorded (its named inputs, its watch-list results, and an explicit
   "no rollback required" statement).
2. **`DEPLOYMENT.md`'s v1-rollback block (around `:585-600`) is superseded.** It
   currently instructs an operator to derive `RELEASE_SHA` from the frozen DeepSeek
   binding, which names the **v1** candidate. That block is correct only while a v1
   rollback is still possible. Retiring v1 makes it an incident landmine of exactly
   the D1 class, so it must be rewritten BEFORE step 1 below, not after.
3. **Production has served v2 for the full soak window on the exact retirement
   candidate**, with the deployed SHA named in the record.

> **Step 8 forfeits rollback.** Once the flag collapses there is no supported path
> back to the v1 engine without a revert-and-redeploy. Treat step 8 as a one-way
> door and take it deliberately, in its own window.

---

## What is NOT deletable

Listing this first, because the highest-risk mistake here is over-deletion.

- **`src/routes/control-plane.ts` SURVIVES.** It is not v1 code. C10 moved the
  engine-neutral control plane OUT of `chat-pipeline.ts` precisely so v1 could be
  retired; deleting it with v1 removes the authority quartet, both rate limiters,
  `chatPreconditions`, `commitConfirmation`, `recordUndoIfReversible`, and the
  shared `ChatPipeline`/`ChatTurnOutcome`/`ChatPreconditions`/
  `CommitConfirmationOutcome` types that **v2 depends on**.
- **Shared modules stay:** `assistant/model-client.ts`, `assistant/model-endpoint.ts`,
  `assistant/select-model-client.ts`, `assistant/gemini-cli-client.ts`,
  `assistant/tool-results.ts`, `harness/actions.ts`, `harness/catalog.ts`.

## Deletable budget (measured at this commit)

| Module | Lines |
|---|---|
| `assistant/intent-declaration.ts` | 1,238 |
| `harness/tool-select.ts` | 331 |
| `harness/intent-capability.ts` | 315 |
| `harness/intent-authority.ts` | 304 |
| `assistant/planner.ts` | 208 |
| `assistant/prompts.ts` | 208 |
| `assistant/agent-loop.ts` | 202 |
| `assistant/agent-state.ts` | 103 |
| `assistant/usage.ts` | 87 |
| `assistant/text-safety.ts` | 84 |
| `assistant/intent-candidates.ts` | 12 |
| **subtotal** | **3,092** |
| `routes/chat-pipeline.ts` (residual, v1-only after C10) | 1,617 |
| `routes/chat-results.ts` (v1-only portion, approx) | ~200 |
| **total** | **≈4,909 lines** |

Plus **27 test files** that reference a v1 module (`grep -rl` over the v1 module
names at this commit).

**Correction to the source plan:** it budgeted ≈5,200 lines + ~19 test files and
estimated the `chat-pipeline.ts` residual at ≈1,900. Measured: the residual is
**1,617**, the test-file count is **27**, and **679 lines moved into
`control-plane.ts`, i.e. OUT of the deletable budget** — they are now shared
infrastructure. Re-measure before executing; these numbers drift.

---

## The order

### 1. Rewrite `DEPLOYMENT.md`'s rollback block (entry-gate item 2)
Nothing else may start first. See the gate above.

### 2. Repoint the type imports off `chat-pipeline.js` — **the C10 coupling**
C10 left `chat-pipeline.ts` re-exporting the four shared types so v1-side imports
kept resolving. Four sites still import from there and MUST be repointed at
`./control-plane.js` before `chat-pipeline.ts` can be deleted, or the build breaks:

- `src/routes/api.ts:11`
- `src/routes/confirmations.ts:3`
- `src/routes/chat.ts:6`
- `tests/integration/routes.test.ts:14`

(`tests/integration/route-mutation-settlement.test.ts:2` imports the `createChatPipeline`
VALUE and dies with step 7, not here.)

### 3. Split the v1-only portion out of `chat-results.ts`
`sanitizeResultsForHistory` (`chat-results.ts:330`) is LIVE for v2 via
`services/history-service.ts:6`. Separate the v2-reachable transforms from the
v1-only ones before deleting anything in this file.

### 4. One observed window on the v2 default
C11 already flipped `ASSISTANT_ENGINE`'s default to v2 (2026-07-31). Confirm one
full observed window on the default before proceeding.

### 5. ⚠ Retire the `isV2Preview` false arm — **PRECONDITION REQUIRED, do not execute as written**

The source plan lists this as a simple deletion of the false arm at
`routes/confirmations.ts:51-58`. **That is unsafe at this commit**, and the reason
was found by adversarial review during C10:

`isV2AssistantPreviewConfirmation` is **not** just the v2-authority predicate —
`harness/confirmations.ts:418-420` is `isV2PreviewAuthority(record) && !record.batchId`.
A v2 **multi-write** preview stamps `batch_id` on every pending row
(`services/operation-preparation-service.ts:368-382` →
`db/store/assistant-write-preparation.ts:195` → `db/store/confirmation-batches.ts:142`).
And `routes/confirmations.ts` has **no batch guard on the confirm path** —
`isBatchOwned` is consulted only at `:158`, inside the CANCEL handler. So a
batched v2 row POSTed to `/confirmations/:id/confirm` evaluates `isV2Preview(record)`
false and falls through to v1's `commitConfirmation` at `:58`.

Deleting the false arm without addressing this turns that request into a runtime
failure after v1 is gone.

Note the shipped UI normally routes "Confirm all" to the aggregate batch endpoint
(`ui/api-client.ts:73 confirmBatch` → `routes/confirmation-batches.ts`), so this is
not the common path — but the single-confirm ROUTE accepts a batched row today, and
a stale card, a replay, or a hand-made request reaches it.

**Choose one and record the choice before executing this step:**
- (a) Widen `isV2AssistantPreviewConfirmation` to admit batched rows, so v2's own
  service handles them; or
- (b) Add an explicit batch guard to the confirm path that rejects a batched row
  with a typed error pointing at the batch endpoint; or
- (c) Prove no batched row can reach `/confirmations/:id/confirm` and pin that with
  a test.

Option (c) is a claim about the whole surface, not just the UI — prefer (a) or (b).

### 6. Delete the leaf v1 modules
`planner.ts`, `prompts.ts`, `agent-loop.ts`, `agent-state.ts`, `usage.ts`,
`text-safety.ts`, `intent-candidates.ts`, `tool-select.ts` — plus their tests.
Run `npm run orphans` after each: it will name anything that becomes unreachable.

### 7. Retire the intent vertical + its migration
`intent-declaration.ts`, `intent-authority.ts`, `intent-capability.ts`, and a
migration dropping `intent_capabilities` / `intent_capability_usage`. Schema
version at this commit is 13; C5 kept `entity_references`, so this migration takes
the next free version — confirm it at execution time rather than hard-coding one.

### 8. Delete `chat-pipeline.ts` and the v1 factory arm
`routes/api.ts` `AssistantPipelineFactories.v1` and the `case "v1"` arm of
`createSelectedAssistantPipeline`. Step 2 must already be done.

### 9. ⛔ LAST — collapse the flag (forfeits rollback)
Narrow `ASSISTANT_ENGINE` from `z.enum(["v1","v2"])` to a single value or remove it,
retire the `v1-candidate-build` CI job, and re-mark the five v1 evidence suites
historical. **C11 deliberately kept the enum two-valued so this remains the last,
separate, owner-gated step.**

---

## Anchors corrected while writing this

- **Dropped the `src/harness/scope-contract.ts:50` anchor.** The source plan already
  suspected it; verified here. The file is `src/addon/scope-contract.ts`, and it
  imports `FeatureGroup` from `../harness/permissions.js` — it does **not** import
  `harness/catalog`. It is not part of this sequence.
- **Test-file count re-verified at HEAD: 27**, not 19. C6 deleted two test files and
  C4/C9 rewrote others, so re-measure at execution time.
- **`control-plane.ts` added to the do-not-delete list** — it did not exist when the
  source plan was written.
