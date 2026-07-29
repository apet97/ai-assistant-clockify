import { expect, type APIRequestContext, type Page } from "@playwright/test";

/** Control-plane view of one scenario activation (tests/e2e-real/server/main.ts). */
export interface ScenarioHandles {
  componentUrl: string;
  memberComponentUrl: string;
  workspaceId: string;
  adminUserId: string;
}

export interface ServerCounters {
  providerCalls: number;
  clockifyCalls: number;
  clockifyMutations: number;
}

export async function startScenario(
  request: APIRequestContext,
  name: string,
): Promise<ScenarioHandles> {
  const res = await request.post("/e2e/scenario", { data: { name } });
  expect(res.ok()).toBe(true);
  return (await res.json()) as ScenarioHandles;
}

export async function counters(request: APIRequestContext): Promise<ServerCounters> {
  const res = await request.get("/e2e/state");
  expect(res.ok()).toBe(true);
  return (await res.json()) as ServerCounters;
}

export async function advanceClock(request: APIRequestContext, advanceMs: number): Promise<void> {
  const res = await request.post("/e2e/clock", { data: { advanceMs } });
  expect(res.ok()).toBe(true);
}

/** Open the assistant through the REAL signed-JWT component entry. */
export async function openAssistant(page: Page, componentUrl: string): Promise<void> {
  await page.goto(componentUrl);
  await expect(page.getByRole("heading", { name: "AI Assistant" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
}

export async function send(page: Page, message: string): Promise<void> {
  const input = page.getByRole("textbox", { name: "Message" });
  await expect(input).toBeEnabled();
  await input.fill(message);
  await input.press("Enter");
  await expect(page.locator(".message.user").last()).toHaveText(message);
}
