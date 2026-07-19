import { expect, test } from "@playwright/test";
import { openAssistant, tabTo } from "./helpers.js";

const permissionGroups = [
  "Time tracking",
  "Work structure",
  "Reports",
  "Invoices",
  "Expenses",
  "Users & groups",
  "Time off approvals",
  "Scheduling",
  "Webhooks",
  "Workspace settings",
  "Custom fields",
  "Approvals",
  "Audit log",
] as const;

test("first-run disclosure and permissions are completable with the keyboard", async ({ page, browserName }) => {
  await openAssistant(page, { scenario: "first-run", theme: "dark", language: "sr" });

  await expect(page.getByRole("heading", { name: "Set up your assistant permissions" })).toBeVisible();
  await expect(page.getByText("DeepSeek processes chat requests for this assistant.")).toBeVisible();
  await expect(page.getByText("typing yes never confirms", { exact: false })).toBeVisible();
  await expect(page.getByRole("table", { name: "Assistant permissions by feature group" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: /^Permission level for / })).toHaveCount(permissionGroups.length);
  for (const group of permissionGroups) {
    await expect(page.getByRole("combobox", { name: `Permission level for ${group}` })).toHaveValue("read_write");
  }

  const timeTracking = page.getByRole("combobox", { name: "Permission level for Time tracking" });
  await tabTo(page, timeTracking, browserName);
  await page.keyboard.type("Off");
  await expect(timeTracking).toHaveValue("off");

  const save = page.getByRole("button", { name: "Save permissions" });
  await tabTo(page, save, browserName);
  await page.keyboard.press("Enter");

  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeFocused();
  await page.keyboard.type("read");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Here is your read-only summary.")).toBeVisible();
  await expect(composer).toBeFocused();

  const saved = await page.request.get("/api/permissions");
  const savedPolicy = (await saved.json()).policy;
  expect(savedPolicy.groups.time_tracking).toBe("off");
  expect(Object.keys(savedPolicy.groups)).toHaveLength(permissionGroups.length);
});

test("display controls apply Serbian and dark preferences", async ({ page, browserName }) => {
  await openAssistant(page, { theme: "light", language: "en" });
  const display = page.getByRole("button", { name: "Display" });
  await tabTo(page, display, browserName, 80, true);
  await page.keyboard.press("Enter");

  const theme = page.getByRole("combobox", { name: "Theme" });
  await expect(theme).toBeFocused();
  await expect(page.getByText("Clockify time zone", { exact: false })).toContainText("Europe/Belgrade");
  await page.keyboard.type("Dark");
  await expect(theme).toHaveValue("dark");

  const language = page.getByRole("combobox", { name: "Language" });
  await tabTo(page, language, browserName);
  await page.keyboard.type("Srpski");
  await expect(language).toHaveValue("sr");

  const save = page.getByRole("button", { name: "Save display" });
  await tabTo(page, save, browserName);
  await page.keyboard.press("Enter");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("lang", "sr");
  await expect(display).toBeFocused();
});
