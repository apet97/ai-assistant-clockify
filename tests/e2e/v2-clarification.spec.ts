import { expect, test, type Page } from "@playwright/test";
import { openAssistant } from "./helpers.js";

/**
 * T14-F/CP-C: v2 durable-clarification E2E coverage (chip click across browsers,
 * page reload restoration, second-tab restoration).
 *
 * UN-SKIPPED BY CP-C — do not delete this history when editing.
 *
 * This file was `test.describe.skip` from T14-F through the T14-T16 review gate
 * for one reason: no live path ever created a `pending_clarifications` row.
 * `executeV2Read`'s clarify branch minted a `randomUUID()` and returned it
 * WITHOUT calling `store.createPendingClarification`, so a fixture scenario here
 * would have tested the FIXTURE's imagined behavior rather than the product's —
 * green forever regardless of whether the feature worked.
 *
 * CP-A built the producer and CP-B wired the hydration.
 * `tests/integration/v2-clarification-producer.test.ts` proves the REAL server
 * chain (real HTTP -> real runner -> real read action -> real name resolver ->
 * durable row -> journaled `clarification.required` -> hydrated attachment ->
 * exact-`optionId` resolve). The `pending_clarification` frame the fixture
 * serves is copied from that passing test's observed shape, so it is a faithful
 * stand-in for the one layer an in-process test cannot reach: the browser —
 * chip dispatch across three engines, reload, and a second tab.
 */

// Each case here drives a full page load PLUS durable restoration (history +
// a run-events page) and the second-tab case loads two pages, so these are
// heavier than the config's 20s default was sized for: at three concurrent
// Firefox workers on a laptop they land right on that ceiling (~5s each when
// run alone). This raises only the time budget — every assertion below is
// unchanged and none of them poll for longer.
test.describe.configure({ timeout: 60_000 });

const CLARIFICATION_QUESTION = 'Several workspace users match "Alice". Which one should I list entries for?';
const OPTION_ONE_ID = "aaaaaaaaaaaaaaaaaaaaaaa1";
const OPTION_ONE_LABEL = "Alice (alice.one@example.com)";
const OPTION_TWO_LABEL = "Alice (alice.two@example.com)";

function chipRow(page: Page) {
  return page.getByRole("group", { name: "Suggested replies" });
}

/**
 * Chip clicks go through one helper so the "the chip submits the exact id"
 * contract has a single point of truth.
 */
async function clickChip(page: Page, label: string): Promise<void> {
  await chipRow(page).getByRole("button", { name: label }).click();
}

async function recordedResolves(page: Page): Promise<string[]> {
  const res = await page.request.get("/api/e2e/clarification-resolves");
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { resolves: string[] }).resolves;
}

test("a restored pending clarification renders its question and grounded chips", async ({ page }) => {
  await openAssistant(page, { scenario: "clarification" });
  // The question comes from the attachment's `question` — the resolver's own
  // sentence, not the `missingField` key the pre-CP-B placeholder rendered.
  await expect(page.locator(".clarify")).toContainText(CLARIFICATION_QUESTION);
  await expect(page.locator(".clarify")).not.toContainText("userId");
  const row = chipRow(page);
  await expect(row.getByRole("button", { name: OPTION_ONE_LABEL })).toBeEnabled();
  await expect(row.getByRole("button", { name: OPTION_TWO_LABEL })).toBeEnabled();
});

test("chip click resolves by id, not label", async ({ page }) => {
  await openAssistant(page, { scenario: "clarification" });
  await clickChip(page, OPTION_ONE_LABEL);

  // The server received the EXACT option id. The fixture rejects anything that
  // is not a stored candidate id (mirroring the real route), so submitting the
  // label would have produced `unknown_option` instead of this receipt.
  await expect(page.getByRole("group", { name: "Done: List time entries" })).toContainText(OPTION_ONE_ID);
  const resolves = await recordedResolves(page);
  expect(resolves).toEqual([OPTION_ONE_ID]);
  expect(resolves).not.toContain(OPTION_ONE_LABEL);
});

test("chips disable after a click so a clarification is one-use", async ({ page }) => {
  await openAssistant(page, { scenario: "clarification" });
  const row = chipRow(page);
  await clickChip(page, OPTION_TWO_LABEL);
  await expect(row.getByRole("button", { name: OPTION_ONE_LABEL })).toBeDisabled();
  await expect(row.getByRole("button", { name: OPTION_TWO_LABEL })).toBeDisabled();
});

test("page reload restores the pending clarification and its chips", async ({ page }) => {
  await openAssistant(page, { scenario: "clarification" });
  await expect(chipRow(page).getByRole("button", { name: OPTION_ONE_LABEL })).toBeEnabled();

  // Reload WITHOUT the scenario query: the state belongs to the server session,
  // so restoration must come from history + durable run events, not the URL.
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await expect(page.locator(".clarify")).toContainText(CLARIFICATION_QUESTION);
  await expect(chipRow(page).getByRole("button", { name: OPTION_ONE_LABEL })).toBeEnabled();
  // Restoration is idempotent: the durable event renders exactly once.
  await expect(page.locator(".clarify")).toHaveCount(1);
});

test("a second browser tab observes the same pending clarification", async ({ page, context }) => {
  await openAssistant(page, { scenario: "clarification" });
  await expect(chipRow(page).getByRole("button", { name: OPTION_ONE_LABEL })).toBeEnabled();

  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await expect(second.locator(".clarify")).toContainText(CLARIFICATION_QUESTION);
  await expect(chipRow(second).getByRole("button", { name: OPTION_ONE_LABEL })).toBeEnabled();

  // Resolving in the second tab settles it once; the first tab's already
  // rendered chips are stale UI, never a second server-side resolution.
  await clickChip(second, OPTION_ONE_LABEL);
  await expect(second.getByRole("group", { name: "Done: List time entries" })).toBeVisible();
  expect(await recordedResolves(second)).toEqual([OPTION_ONE_ID]);
  await second.close();
});

test("a clarification already being resolved renders no actionable chips", async ({ page }) => {
  await openAssistant(page, { scenario: "clarification-resolving" });
  await expect(page.locator(".clarify")).toContainText(CLARIFICATION_QUESTION);
  const row = chipRow(page);
  await expect(row.getByRole("button", { name: OPTION_ONE_LABEL })).toBeDisabled();
  await expect(row.getByRole("button", { name: OPTION_TWO_LABEL })).toBeDisabled();
  expect(await recordedResolves(page)).toEqual([]);
});
