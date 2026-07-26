import { test } from "@playwright/test";

/**
 * T14-F: v2 durable-clarification E2E coverage (chip click across browsers,
 * page reload restoration, second-tab restoration).
 *
 * DELIBERATELY SKIPPED — do not remove this comment when un-skipping.
 *
 * There is no live path that ever creates a `pending_clarifications` row.
 * `executeV2Read`'s clarify branch (`src/assistant-v2/read-execution.ts`)
 * mints a `randomUUID()` clarification id and returns it to the caller
 * WITHOUT calling `store.createPendingClarification` — this is the exact gap
 * flagged at T14-D's closure and carried forward through T14-E. T14-D/T14-F
 * built the resolve SIDE (`POST /api/clarifications/:id/resolve`, the UI chip
 * dispatch) against a clarification that could exist; nothing in this branch
 * makes one exist at runtime.
 *
 * `tests/e2e/fixtures/server.mjs` is a hand-written mock HTTP server, not the
 * real app. Inventing a mock `pending_clarification` scenario there would
 * test the FIXTURE's imagined behavior, not the product's — a spec built
 * that way would stay green forever regardless of whether the real feature
 * works, which is worse than no test. `tests/integration/v2-clarification-ui.test.ts`
 * covers everything that IS real today: chip dispatch (id vs label), disabled
 * gating, XSS/Unicode labels, and the `applyRunEventAttachment` mapping.
 *
 * Un-skip this file once a real slice wires clarification-row creation into
 * `read-execution.ts` (flagged for the T14-T16 review gate as having no
 * owning slice) — at that point the fixture server can drive a real
 * `awaiting_clarification` run and this spec can click a real chip, reload,
 * and open a second tab against it.
 */
test.describe.skip("v2 durable clarification (blocked: no live clarification-creation path yet)", () => {
  test("chip click resolves by id, not label", async () => {
    /* intentionally empty — see file header */
  });

  test("page reload restores the pending clarification and its chips", async () => {
    /* intentionally empty — see file header */
  });

  test("a second browser tab observes the same pending clarification", async () => {
    /* intentionally empty — see file header */
  });
});
