import { expect, test } from "@playwright/test";
import {
  advanceClock,
  counters,
  openAssistant,
  send,
  startScenario,
} from "./helpers.js";

/**
 * Closure-plan PR 12 (F05): the review's journey list executed against the
 * REAL server — tsc-built production composition, real SQLite, real signed-JWT
 * component auth, the built UI bundle, and NO hand-authored frames. Scenario
 * switching mutates the one shared server, so the suite is serial (workers=1).
 */
test.describe.configure({ mode: "serial" });

test("read journey: grounded answer, presented card, both survive reload", async ({ page, request }) => {
  const scenario = await startScenario(request, "read-grounded");
  await openAssistant(page, scenario.componentUrl);

  await send(page, "What projects do we have?");
  await expect(
    page.getByText("You have two active projects: Website launch and Internal tools."),
  ).toBeVisible();
  const card = page.getByRole("group", { name: /Done: List projects/ });
  await expect(card).toBeVisible();
  await expect(card).toContainText("items returned");
  await expect(card).toContainText("2");

  const state = await counters(request);
  expect(state.clockifyMutations).toBe(0);

  await page.reload();
  await expect(
    page.getByText("You have two active projects: Website launch and Internal tools."),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: /Done: List projects/ })).toBeVisible();
});

test("read failure surfaces honestly and the next message succeeds", async ({ page, request }) => {
  const scenario = await startScenario(request, "read-failure");
  await openAssistant(page, scenario.componentUrl);

  await send(page, "List my projects");
  await expect(
    page.getByText("I couldn't load your projects just now. Please try again."),
  ).toBeVisible();

  await send(page, "Try again");
  await expect(page.getByText("Second try: you have two active projects.")).toBeVisible();
  const state = await counters(request);
  expect(state.clockifyMutations).toBe(0);
});

test("preview renders a Confirm button with zero mutations before the click", async ({ page, request }) => {
  const scenario = await startScenario(request, "write-preview");
  await openAssistant(page, scenario.componentUrl);

  await send(page, "Create a tag called Billable");
  const card = page.getByRole("group", { name: "Change awaiting confirmation" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Create a tag");
  await expect(card.getByRole("button", { name: "Confirm" })).toBeVisible();
  await expect(page.getByText("Review the preview and click Confirm.")).toBeVisible();

  const state = await counters(request);
  expect(state.clockifyMutations).toBe(0);
});

test("single confirm commits exactly one mutation and renders the receipt", async ({ page, request }) => {
  const scenario = await startScenario(request, "write-preview");
  await openAssistant(page, scenario.componentUrl);

  await send(page, "Create a tag called Billable");
  const card = page.getByRole("group", { name: "Change awaiting confirmation" });
  await card.getByRole("button", { name: "Confirm" }).click();

  // The confirm stream delivers the canonical committed receipt (the
  // engine-shared v1-shaped frame): truthful outcome, created entity, undo.
  const receipt = page.getByRole("group", { name: /Done: clockify_tags_create/ });
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText("Billable");
  const state = await counters(request);
  expect(state.clockifyMutations).toBe(1);
});

test("cancel settles the preview with no mutation", async ({ page, request }) => {
  const scenario = await startScenario(request, "write-preview");
  await openAssistant(page, scenario.componentUrl);

  await send(page, "Create a tag called Billable");
  const card = page.getByRole("group", { name: "Change awaiting confirmation" });
  await card.getByRole("button", { name: "Cancel" }).click();

  await expect(page.getByText("Cancelled.")).toBeVisible();
  await expect(card).toHaveCount(0);
  const state = await counters(request);
  expect(state.clockifyMutations).toBe(0);
});

test("an expired preview refuses to commit and says why", async ({ page, request }) => {
  const scenario = await startScenario(request, "write-preview");
  await openAssistant(page, scenario.componentUrl);

  await send(page, "Create a tag called Billable");
  const card = page.getByRole("group", { name: "Change awaiting confirmation" });
  await expect(card.getByRole("button", { name: "Confirm" })).toBeVisible();

  // The confirmation TTL is 5 minutes; jump past it on the server clock.
  await advanceClock(request, 6 * 60 * 1000);
  await card.getByRole("button", { name: "Confirm" }).click();

  await expect(page.getByRole("alert")).toContainText(/expired/i);
  const state = await counters(request);
  expect(state.clockifyMutations).toBe(0);
});

test("exact batch: one card, Confirm all commits both members", async ({ page, request }) => {
  const scenario = await startScenario(request, "write-batch");
  await openAssistant(page, scenario.componentUrl);

  await send(page, "Create the batch tag and project");
  const card = page.getByRole("group", { name: "2 changes awaiting confirmation" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Create a tag");
  await expect(card).toContainText("Create a project");

  await card.getByRole("button", { name: "Confirm all" }).click();
  await expect(card.locator(".batch-outcome.ok")).toHaveCount(2);
  const state = await counters(request);
  expect(state.clockifyMutations).toBe(2);
});

test("exact batch: Cancel all settles the whole batch with zero mutations", async ({ page, request }) => {
  const scenario = await startScenario(request, "write-batch");
  await openAssistant(page, scenario.componentUrl);

  await send(page, "Create the batch tag and project");
  const card = page.getByRole("group", { name: "2 changes awaiting confirmation" });
  await card.getByRole("button", { name: "Cancel" }).click();

  await expect(page.getByText("Cancelled.")).toBeVisible();
  await expect(card).toHaveCount(0);
  const state = await counters(request);
  expect(state.clockifyMutations).toBe(0);
});

test("batch ambiguity stops the whole batch before any preview", async ({ page, request }) => {
  const scenario = await startScenario(request, "batch-ambiguity");
  await openAssistant(page, scenario.componentUrl);

  await send(page, "Create the tag and the Acme project");
  // The ambiguous member suspends the run for clarification: no Confirm button,
  // no preview card, zero mutations.
  await expect(page.getByText(/Acme/).first()).toBeVisible();
  await expect(page.getByRole("group", { name: /awaiting confirmation/ })).toHaveCount(0);
  const state = await counters(request);
  expect(state.clockifyMutations).toBe(0);
});

test("clarification resolves through an exact option chip", async ({ page, request }) => {
  const scenario = await startScenario(request, "clarify-option");
  await openAssistant(page, scenario.componentUrl);

  await send(page, "Show the Alpha entries");
  await expect(page.getByRole("button", { name: "Alpha One" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Alpha Two" })).toBeVisible();

  await page.getByRole("button", { name: "Alpha One" }).click();
  await expect(page.getByText("Alpha One has one tracked entry.")).toBeVisible();
  const state = await counters(request);
  expect(state.clockifyMutations).toBe(0);
});

test("clarification resolves through free-text continuation", async ({ page, request }) => {
  const scenario = await startScenario(request, "clarify-freetext");
  await openAssistant(page, scenario.componentUrl);

  await send(page, "Show the Alpha entries");
  await expect(page.getByRole("button", { name: "Alpha One" })).toBeVisible();

  await send(page, "I meant Alpha Two");
  await expect(page.getByText("Alpha Two has one tracked entry.")).toBeVisible();
  const state = await counters(request);
  expect(state.clockifyMutations).toBe(0);
});

test("request replay returns the stored result without a second model run", async ({ page, request }) => {
  const scenario = await startScenario(request, "read-grounded");
  await openAssistant(page, scenario.componentUrl);

  const requestId = "11111111-2222-4333-8444-555555555555";
  const first = await page.evaluate(async (id) => {
    const res = await fetch("/api/chat/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "What projects do we have?", requestId: id }),
    });
    return res.json();
  }, requestId);
  const callsAfterFirst = (await counters(request)).providerCalls;

  const second = await page.evaluate(async (id) => {
    const res = await fetch("/api/chat/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "What projects do we have?", requestId: id }),
    });
    return res.json();
  }, requestId);

  expect(second.reply).toEqual(first.reply);
  expect((await counters(request)).providerCalls).toBe(callsAfterFirst);
});

test("a second tab's restore rotates the nonce; the stale tab recovers and commits once", async ({ page, context, request }) => {
  const scenario = await startScenario(request, "write-preview");
  await openAssistant(page, scenario.componentUrl);

  await send(page, "Create a tag called Billable");
  const card = page.getByRole("group", { name: "Change awaiting confirmation" });
  await expect(card.getByRole("button", { name: "Confirm" })).toBeVisible();

  // Tab B restores the session: the pending nonce rotates, tab A's copy dies.
  const tabB = await context.newPage();
  await openAssistant(tabB, scenario.componentUrl);
  await expect(tabB.getByRole("group", { name: "Change awaiting confirmation" })).toBeVisible();
  await tabB.close();

  // Tab A's stale click re-arms in place with a fresh nonce; the second click
  // commits — exactly one mutation in total.
  await card.getByRole("button", { name: "Confirm" }).click();
  const rearmed = page.getByRole("group", { name: "Change awaiting confirmation" });
  await expect(rearmed.getByRole("button", { name: "Confirm" })).toBeEnabled();
  await rearmed.getByRole("button", { name: "Confirm" }).click();

  await expect(page.getByRole("group", { name: /Done: clockify_tags_create/ })).toBeVisible();
  const state = await counters(request);
  expect(state.clockifyMutations).toBe(1);
});

test("history switcher restores the transcript with the terminal card, not a live control", async ({ page, request }) => {
  const scenario = await startScenario(request, "history-terminal");
  await openAssistant(page, scenario.componentUrl);

  await send(page, "Create the history tag");
  const card = page.getByRole("group", { name: "Change awaiting confirmation" });
  await card.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("group", { name: /Done: clockify_tags_create/ })).toBeVisible();

  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.locator(".message.user")).toHaveCount(0);

  await page.getByRole("button", { name: "Chats" }).click();
  await page.getByRole("menu", { name: "Recent conversations" }).getByRole("menuitem").first().click();

  await expect(page.locator(".message.user").last()).toHaveText("Create the history tag");
  await expect(page.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  const state = await counters(request);
  expect(state.clockifyMutations).toBe(1);
});

test("a non-admin member is rejected before any session exists", async ({ page, request }) => {
  const scenario = await startScenario(request, "member-rejection");

  // Claim-level rejection: the signed JWT carries a non-admin role.
  await page.goto(scenario.memberComponentUrl);
  await expect(
    page.getByText("This add-on is available to Clockify admins and owners only."),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);

  // Live-role rejection: the JWT claims ADMIN but the workspace says member.
  await page.goto(scenario.componentUrl);
  await expect(
    page.getByText("This add-on is available to Clockify admins and owners only."),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
});
