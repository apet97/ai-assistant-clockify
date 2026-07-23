import { expect, test } from "@playwright/test";
import { openAssistant, send } from "./helpers.js";

test.describe("v2 run restoration", () => {
  test("reload restores the conversation without losing the composer", async ({ page }) => {
    await openAssistant(page);
    await send(page, "List my projects");
    await expect(page.locator(".message.assistant").last()).toBeVisible();
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await expect(page.locator(".message.user").last()).toHaveText("List my projects");
  });

  test("second tab reload keeps the same restored transcript", async ({ browser }) => {
    const context = await browser.newContext();
    const first = await context.newPage();
    const second = await context.newPage();
    await openAssistant(first);
    await send(first, "Show clients");
    await openAssistant(second);
    await expect(second.locator(".message.user").last()).toHaveText("Show clients");
    await context.close();
  });
});
