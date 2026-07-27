import { expect, test, type Page } from "@playwright/test";
import { openAssistant, send } from "./helpers.js";

const matrix = [
  { width: 280, height: 720, theme: "light" },
  { width: 320, height: 720, theme: "dark" },
  { width: 375, height: 812, theme: "light" },
  { width: 1024, height: 768, theme: "dark" },
] as const;

const longestReceiptAction = "clockify_workspace_membership_permissions_update";

async function expectAccessibleLayout(page: Page, state: string): Promise<void> {
  const layout = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(layout.documentWidth, `${state}: ${JSON.stringify(layout)}`).toBeLessThanOrEqual(layout.viewport);
  expect(layout.bodyWidth, `${state}: ${JSON.stringify(layout)}`).toBeLessThanOrEqual(layout.viewport);

  const undersized = await page.locator("button:visible, select:visible, input:visible, a:visible").evaluateAll((nodes) =>
    nodes.flatMap((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width + 0.01 >= 44 && rect.height + 0.01 >= 44
        ? []
        : [{ label: node.getAttribute("aria-label") || node.textContent?.trim() || node.tagName, width: rect.width, height: rect.height }];
    }),
  );
  expect(undersized, `${state}: interactive targets must be at least 44x44 CSS pixels`).toEqual([]);
}

for (const entry of matrix) {
  test(`${entry.width}px ${entry.theme} accessibility has no overflow and 44px controls`, async ({ page }) => {
    await page.setViewportSize({ width: entry.width, height: entry.height });
    await openAssistant(page, { scenario: "restricted", theme: entry.theme });

    await expect(page.locator("html")).toHaveAttribute("data-theme", entry.theme);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { name: "What can I do for you?" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show this week's summary report" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start a timer for deep work" })).toHaveCount(0);

    await expectAccessibleLayout(page, "restricted welcome");

    await send(page, "read");
    await expect(page.getByRole("group", { name: "Done: clockify_reports_summary" })).toBeVisible();
    await expectAccessibleLayout(page, "restricted read receipt");

    await send(page, "safe");
    await expect(page.getByRole("group", { name: "Failed: clockify_start_timer" })).toBeVisible();
    await expectAccessibleLayout(page, "restricted write denial");
  });
}

test("280px wraps a long receipt action without clipping the card or document", async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 720 });
  await page.route("**/api/chat/stream", async (route) => {
    const events = [
      {
        type: "result",
        result: {
          kind: "receipt",
          receipt: {
            ok: true,
            action: longestReceiptAction,
            message: "Workspace membership permissions updated.",
          },
        },
      },
      { type: "reply", kind: "final", text: "The permissions were updated." },
      { type: "done" },
    ];
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    });
  });
  await openAssistant(page, { theme: "light" });

  await send(page, "Update workspace membership permissions");
  const card = page.getByRole("group", { name: `Done: ${longestReceiptAction}` });
  const action = card.locator(".action");
  await expect(action).toHaveText(longestReceiptAction);
  await expect(action).toBeVisible();

  const layout = await card.evaluate((node) => {
    const actionNode = node.querySelector<HTMLElement>(".action");
    if (!actionNode) throw new Error("Missing receipt action");
    const cardRect = node.getBoundingClientRect();
    const actionRect = actionNode.getBoundingClientRect();
    const lineHeight = Number.parseFloat(getComputedStyle(actionNode).lineHeight);
    return {
      cardClientWidth: node.clientWidth,
      cardScrollWidth: node.scrollWidth,
      cardLeft: cardRect.left,
      cardRight: cardRect.right,
      actionClientWidth: actionNode.clientWidth,
      actionScrollWidth: actionNode.scrollWidth,
      actionLeft: actionRect.left,
      actionRight: actionRect.right,
      actionHeight: actionRect.height,
      lineHeight,
    };
  });
  expect(layout.cardScrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.cardClientWidth);
  expect(layout.actionScrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.actionClientWidth);
  expect(layout.actionLeft, JSON.stringify(layout)).toBeGreaterThanOrEqual(layout.cardLeft);
  expect(layout.actionRight, JSON.stringify(layout)).toBeLessThanOrEqual(layout.cardRight);
  expect(layout.actionHeight, JSON.stringify(layout)).toBeGreaterThan(layout.lineHeight * 1.5);
  await expectAccessibleLayout(page, "long receipt action");
});

test("280px wraps restored operation action and step labels without clipping", async ({ page }) => {
  const longStepName = "Reconcile workspace membership permissions ".repeat(4).trim();
  await page.setViewportSize({ width: 280, height: 720 });
  await page.route("**/api/chat/history", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        ok: true,
        messages: [],
        pendingPreviews: [],
        operationRuns: [{
          id: "operation-long-label",
          actionName: longestReceiptAction,
          status: "executing",
          steps: [{ planStepId: "step-1", name: longStepName, status: "executing" }],
        }],
      }),
    });
  });
  await openAssistant(page, { theme: "dark" });

  const card = page.getByRole("group", { name: `Operation executing: ${longestReceiptAction}` });
  const action = card.locator(".action");
  const step = card.locator(".operation-steps li");
  await expect(action).toHaveText(longestReceiptAction);
  await expect(step).toContainText(longStepName);

  const layout = await card.evaluate((node) => {
    const actionNode = node.querySelector<HTMLElement>(".action");
    const stepNode = node.querySelector<HTMLElement>(".operation-steps li");
    if (!actionNode || !stepNode) throw new Error("Missing restored operation content");
    const cardRect = node.getBoundingClientRect();
    const actionRect = actionNode.getBoundingClientRect();
    const lineHeight = Number.parseFloat(getComputedStyle(actionNode).lineHeight);
    return {
      cardClientWidth: node.clientWidth,
      cardScrollWidth: node.scrollWidth,
      actionClientWidth: actionNode.clientWidth,
      actionScrollWidth: actionNode.scrollWidth,
      actionRight: actionRect.right,
      actionHeight: actionRect.height,
      stepClientWidth: stepNode.clientWidth,
      stepScrollWidth: stepNode.scrollWidth,
      cardRight: cardRect.right,
      lineHeight,
    };
  });
  expect(layout.cardScrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.cardClientWidth);
  expect(layout.actionScrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.actionClientWidth);
  expect(layout.stepScrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.stepClientWidth);
  expect(layout.actionRight, JSON.stringify(layout)).toBeLessThanOrEqual(layout.cardRight);
  expect(layout.actionHeight, JSON.stringify(layout)).toBeGreaterThan(layout.lineHeight * 1.5);
  await expectAccessibleLayout(page, "restored operation labels");
});

for (const width of [280, 320, 375] as const) {
  test(`${width}px first-run renders every permission without horizontal scrolling`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await openAssistant(page, { scenario: "first-run", theme: "dark" });

    const panel = page.getByRole("region", { name: "Assistant permissions" });
    await expect(panel.getByRole("combobox", { name: /^Permission level for / })).toHaveCount(13);
    await expectAccessibleLayout(page, "first-run permissions");
    const panelWidths = await panel.evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
    }));
    expect(panelWidths.scrollWidth, JSON.stringify(panelWidths)).toBeLessThanOrEqual(panelWidths.clientWidth);
  });
}

test("1440x900 release capture keeps all 13 permission controls in-frame", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAssistant(page, { scenario: "first-run", theme: "dark" });

  const controls = page.getByRole("combobox", { name: /^Permission level for / });
  await expect(controls).toHaveCount(13);
  const bounds = await controls.evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  }));
  expect(Math.min(...bounds.map(({ top }) => top))).toBeGreaterThanOrEqual(0);
  expect(Math.max(...bounds.map(({ bottom }) => bottom))).toBeLessThanOrEqual(900);
});
