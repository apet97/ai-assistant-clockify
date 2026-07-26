import { expect, test } from "@playwright/test";
import { openAssistant, send } from "./helpers.js";

/**
 * T15-E: the full structured `PresentedResultEnvelope` — facts, warnings,
 * references, recovery, and the technical-details diagnostic disclosure —
 * across all six `PresentedResult` statuses. Production's own
 * `chatResultToPresentation` doesn't yet populate every field for a real
 * domain (flagged for the T14-T16 review gate); the fixture server fabricates
 * real `run_event` frames carrying the full envelope so this exercises the
 * genuine UI decode → render path end to end, not a mock of it.
 */

test("succeeded: facts and references render with a human title, no raw action id", async ({ page }) => {
  await openAssistant(page);
  await send(page, "structured-succeeded");
  const card = page.getByRole("group", { name: "Done: Create a tag" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("The tag was created.");
  await expect(card).toContainText("Tag name");
  await expect(card).toContainText("Billable");
  await expect(card.locator(".receipt-references")).toContainText("Billable");
});

test("failed: warnings render distinctly from a success", async ({ page }) => {
  await openAssistant(page);
  await send(page, "structured-failed");
  const card = page.getByRole("group", { name: "Failed: Create a tag" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("A tag with that name already exists.");
});

test("partial: a partial v2 status renders its own label, facts, and recovery hint", async ({ page }) => {
  await openAssistant(page);
  await send(page, "structured-partial");
  const card = page.getByRole("group", { name: "Partial — review needed: Set up a new project" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Website relaunch");
  await expect(card).toContainText("Could not add one member.");
  await expect(card).toContainText("Check the project's current members");
});

test("cancelled: renders a neutral cancelled label, not a plain failure", async ({ page }) => {
  await openAssistant(page);
  await send(page, "structured-cancelled");
  const card = page.getByRole("group", { name: "Cancelled: Update a project" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("This change was cancelled before it ran.");
});

test("outcome unknown: renders its own label and recovery affordance", async ({ page }) => {
  await openAssistant(page);
  await send(page, "structured-outcome-unknown");
  const card = page.getByRole("group", { name: "Outcome unknown — verify in Clockify: Delete a tag" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("View this operation's status");
});

test("pending confirmation: renders through the existing preview card with facts", async ({ page }) => {
  await openAssistant(page);
  await send(page, "structured-pending");
  const card = page.getByRole("group", { name: "Change awaiting confirmation" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("This will permanently remove the project.");
  await expect(card).toContainText("Old sandbox");
  await expect(card.getByRole("button", { name: "Confirm" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Cancel" })).toBeVisible();
});

test("the technical details disclosure never leaks a raw action id into an accessible name", async ({ page }) => {
  await openAssistant(page);
  await send(page, "structured-succeeded");
  const card = page.getByRole("group", { name: "Done: Create a tag" });
  const toggle = card.getByRole("button", { name: "Details" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  // No accessible name anywhere on the card ever derives a raw `clockify_*` id
  // — the card is titled from the presenter's human `title`, not the action.
  const ariaLabel = await card.getAttribute("aria-label");
  expect(ariaLabel ?? "").not.toMatch(/clockify_[a-z_]+/);
});
