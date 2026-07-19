import { expect, test } from "@playwright/test";
import { openAssistant } from "./helpers.js";

test("first-run initialization fetches the permissions policy exactly once", async ({ page }) => {
  let permissionsGets = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/permissions") permissionsGets += 1;
  });

  await openAssistant(page, { scenario: "first-run" });

  expect(permissionsGets).toBe(1);
});

test("manually reopening permissions refreshes the policy from the server", async ({ page }) => {
  let permissionsGets = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/permissions") permissionsGets += 1;
  });

  await openAssistant(page);
  expect(permissionsGets).toBe(1);
  await page.getByRole("button", { name: "Assistant permissions" }).click();
  await expect(page.getByRole("region", { name: "Assistant permissions" })).toBeVisible();

  expect(permissionsGets).toBe(2);
});

test("acknowledges a submitted request before a slow ordered history restore completes", async ({ page }) => {
  await openAssistant(page, { scenario: "slow-history" });
  const input = page.getByRole("textbox", { name: "Message" });

  await page.evaluate(() => {
    const form = document.querySelector('form[aria-label="Send a message to the assistant"]');
    if (!(form instanceof HTMLFormElement)) throw new Error("Composer form is unavailable.");
    (window as typeof window & { __statusObservation?: Promise<{ delayMs: number; text: string }> }).__statusObservation = new Promise((resolve) => {
      form.addEventListener("submit", () => {
        const startedAt = performance.now();
        const observer = new MutationObserver(() => {
          const node = document.querySelector('[role="status"]');
          if (node?.textContent?.includes("Understanding your request")) {
            observer.disconnect();
            resolve({ delayMs: performance.now() - startedAt, text: node.textContent });
          }
        });
        observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      }, { capture: true, once: true });
    });
  });

  await input.fill("read");
  await input.press("Enter");
  const observation = await page.evaluate(() => (
    window as typeof window & { __statusObservation: Promise<{ delayMs: number; text: string }> }
  ).__statusObservation);
  expect(observation.text).toContain("Understanding your request");
  expect(observation.delayMs).toBeLessThan(100);
});

test("surfaces a malformed /api/me response instead of silently keeping stale local preferences", async ({ page }) => {
  await openAssistant(page, { scenario: "malformed-me" });
  await expect(page.getByRole("alert")).toContainText("The assistant sent an invalid response");
});

test("a saved read-only policy immediately refreshes welcome copy and suggestions", async ({ page }) => {
  await openAssistant(page);
  await page.getByRole("button", { name: "Assistant permissions" }).click();
  const panel = page.getByRole("region", { name: "Assistant permissions" });
  const permissionLevels = panel.getByRole("combobox", { name: /^Permission level for / });
  await expect(permissionLevels).toHaveCount(13);
  for (const select of await permissionLevels.all()) await select.selectOption("read");
  await panel.getByRole("button", { name: "Save permissions" }).click();
  await expect(panel.getByRole("status")).toHaveText("Saved");
  await panel.getByRole("button", { name: "Close" }).click();

  await expect(page.getByText("Changes are disabled by your saved permission policy.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start a timer for deep work" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "What did I track today?" })).toBeVisible();
});

test("Serbian preferences localize relative time and the currency-bearing suggestion with Intl", async ({ page }) => {
  await openAssistant(page, { language: "sr" });
  await expect(page.getByRole("button", { name: /Log a 50,00.*US\$ travel expense/ })).toBeVisible();

  await page.getByRole("button", { name: "Chats" }).click();
  const labels = await page.locator(".chats-time").allTextContents();
  expect(labels.length).toBeGreaterThan(0);
  expect(labels.join(" ")).not.toContain("ago");
  expect(labels.join(" ")).toMatch(/sada|juče|prekjuče|pre /);
});
