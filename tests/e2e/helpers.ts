import { expect, type Locator, type Page } from "@playwright/test";

export async function openAssistant(
  page: Page,
  options: { scenario?: string; theme?: "light" | "dark" } = {},
): Promise<void> {
  const query = new URLSearchParams({
    scenario: options.scenario ?? "default",
    theme: options.theme ?? "light",
  });
  await page.goto(`/?${query}`);
  await expect(page.getByRole("heading", { name: "AI Assistant" })).toBeVisible();
  if (options.scenario === "first-run") {
    await expect(page.getByRole("heading", { name: "Set up your assistant permissions" })).toBeVisible();
  } else {
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  }
}

export async function send(page: Page, message: string): Promise<void> {
  const input = page.getByRole("textbox", { name: "Message" });
  await expect(input).toBeEnabled();
  await input.fill(message);
  await input.press("Enter");
  await expect(page.locator(".message.user").last()).toHaveText(message);
}

export async function tabTo(
  page: Page,
  target: Locator,
  browserName = "chromium",
  limit = 40,
  backwards = false,
): Promise<void> {
  // Safari/WebKit on macOS follows the platform default and Option+Tab is the
  // full-keyboard-access gesture for links and buttons.
  const key = [browserName === "webkit" ? "Alt" : "", backwards ? "Shift" : "", "Tab"]
    .filter(Boolean)
    .join("+");
  for (let index = 0; index < limit; index += 1) {
    if (await target.evaluate((node) => node === document.activeElement).catch(() => false)) return;
    await page.keyboard.press(key);
  }
  throw new Error(`Keyboard focus did not reach ${await target.getAttribute("aria-label") ?? await target.textContent()}`);
}
