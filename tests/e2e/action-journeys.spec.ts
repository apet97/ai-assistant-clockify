import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { openAssistant, send, tabTo } from "./helpers.js";

test("read receipt and immediate safe write with undo stay truthful", async ({ page, browserName }) => {
  await openAssistant(page);

  await send(page, "read");
  await expect(page.getByRole("group", { name: "Done: clockify_reports_summary" })).toContainText("Loaded 3 time entries totaling 7h 30m.");
  await expect(page.getByText("Here is your read-only summary.")).toBeVisible();

  await send(page, "safe");
  const safeReceipt = page.getByRole("group", { name: "Done: clockify_start_timer" });
  await expect(safeReceipt).toContainText("Timer started for Website launch.");
  const undo = safeReceipt.getByRole("button", { name: "Undo clockify_start_timer" });
  await tabTo(page, undo, browserName, 80, true);
  await page.keyboard.press("Enter");
  await expect(safeReceipt.getByText("Undone")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();
});

test("a long mixed journey keeps the header and complete composer in-frame", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAssistant(page);

  await send(page, "read");
  await expect(page.getByRole("group", { name: "Done: clockify_reports_summary" })).toBeVisible();
  await send(page, "safe");
  const safeReceipt = page.getByRole("group", { name: "Done: clockify_start_timer" });
  await expect(safeReceipt).toBeVisible();
  await send(page, "risky-confirm");
  const preview = page.getByRole("group", { name: "Change awaiting confirmation" });
  const confirm = preview.getByRole("button", { name: "Confirm" });
  await tabTo(page, confirm, browserName, 80, true);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("group", { name: "Done: clockify_update_project" })).toBeVisible();
  const undo = safeReceipt.getByRole("button", { name: "Undo clockify_start_timer" });
  await tabTo(page, undo, browserName, 80, true);
  await page.keyboard.press("Enter");
  await expect(safeReceipt.getByText("Undone")).toBeVisible();

  const frame = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".app-header")?.getBoundingClientRect();
    const composer = document.querySelector<HTMLElement>("form.composer")?.getBoundingClientRect();
    if (!header || !composer) throw new Error("Missing shell controls");
    return {
      height: window.innerHeight,
      headerTop: header.top,
      composerBottom: composer.bottom,
    };
  });
  expect(frame.headerTop).toBeGreaterThanOrEqual(0);
  expect(frame.composerBottom).toBeLessThanOrEqual(frame.height - 8);
});

test("risky preview supports button-only confirm and cancel", async ({ page, browserName }) => {
  await openAssistant(page);

  await send(page, "risky-cancel");
  const cancelCard = page.getByRole("group", { name: "Change awaiting confirmation" });
  await expect(cancelCard).toContainText("Change the project name to Website launch v2");
  await expect(cancelCard).toContainText("No automatic undo; edit the project again to restore prior values.");
  await expect(cancelCard).not.toContainText("Can be reversed from this receipt");
  const cancel = cancelCard.getByRole("button", { name: "Cancel" });
  await tabTo(page, cancel, browserName, 80, true);
  await page.keyboard.press("Enter");
  await expect(page.getByText("Cancelled.")).toBeVisible();
  await expect(cancelCard).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();

  await send(page, "risky-confirm");
  const confirmCard = page.getByRole("group", { name: "Change awaiting confirmation" });
  await expect(confirmCard.getByRole("button", { name: "Confirm" })).toBeVisible();
  await send(page, "yes");
  await expect(page.getByText("Echo: yes")).toBeVisible();
  await expect(confirmCard).toBeVisible();
  const confirm = confirmCard.getByRole("button", { name: "Confirm" });
  await tabTo(page, confirm, browserName, 80, true);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("group", { name: "Done: clockify_update_project" })).toContainText("Project updated.");
  await expect(page.getByText("The risky change was confirmed and completed.")).toBeVisible();
  await expect(confirmCard).toHaveCount(0);
});

test("confirm all preserves per-item partial failure", async ({ page, browserName }) => {
  await openAssistant(page);
  await send(page, "batch");

  const card = page.getByRole("group", { name: "2 changes awaiting confirmation" });
  await expect(card).toContainText("Update Project Alpha");
  await expect(card).toContainText("Update Project Beta");
  const confirmAll = card.getByRole("button", { name: "Confirm all" });
  await tabTo(page, confirmAll, browserName, 80, true);
  await page.keyboard.press("Enter");

  await expect(card.locator(".batch-outcome.ok")).toContainText("Confirmed");
  await expect(card.locator(".batch-outcome.failed")).toContainText("Project Beta changed after preview.");
  await expect(page.getByRole("alert")).toContainText("Project Beta changed after preview.");
});

test("history survives reload and past conversations open from the keyboard menu", async ({ page, browserName }) => {
  await openAssistant(page, { scenario: "history" });
  await expect(page.getByText("You tracked 6 hours yesterday.")).toBeVisible();

  await send(page, "read");
  await expect(page.getByText("Here is your read-only summary.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Here is your read-only summary.")).toBeVisible();
  await expect(page.getByRole("group", { name: "Done: clockify_reports_summary" })).toHaveCount(2);

  const chats = page.getByRole("button", { name: "Chats" });
  await tabTo(page, chats, browserName, 20, true);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Yesterday's saved report has 6 hours.")).toBeVisible();
  await expect(chats).toBeFocused();
});

test("invoice PDF downloads through the authenticated same-origin route", async ({ page, request, browserName }) => {
  await openAssistant(page, { theme: "light", language: "sr" });
  await send(page, "pdf");

  const link = page.getByRole("link", { name: "Download invoice PDF: clockify-invoice-INV-42.pdf" });
  await expect(link).toHaveAttribute("href", "/api/artifacts/invoice-pdf-1");
  await tabTo(page, link, browserName, 80, true);
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
  expect(download.suggestedFilename()).toBe("clockify-invoice-INV-42.pdf");
  const bytes = await readFile(await download.path());
  expect(bytes.subarray(0, 8).toString()).toBe("%PDF-1.4");

  const authenticated = await page.request.get("/api/artifacts/invoice-pdf-1");
  expect(authenticated.headers()["content-disposition"]).toBe('attachment; filename="clockify-invoice-INV-42.pdf"');

  const unauthenticated = await request.get("/api/artifacts/invoice-pdf-1");
  expect(unauthenticated.status()).toBe(401);
});
