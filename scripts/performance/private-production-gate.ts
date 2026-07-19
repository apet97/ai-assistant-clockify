import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  chromium,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import {
  FAST_4G_PROFILE,
} from "./local-ui-contract.js";
import {
  PRIVATE_PRODUCTION_SAMPLE_COUNTS,
  buildPrivateProductionEvidence,
  isOutsideWorktree,
  renderPrivateProductionMarkdown,
  validateDeployedRelease,
  validatePrivateProductionEnvironment,
  type DeployedReleaseBinding,
  type PrivateProductionEnvironment,
} from "./private-production-contract.js";

const RESOURCE_PREFIX = "AIASSIST_PERF_";
const CHAT_TIMEOUT_MS = 180_000;
const HTTP_TIMEOUT_MS = 60_000;
const STATUS_STREAM_PATTERN = "**/api/chat/stream";

const SHELL_PROBE_SCRIPT = String.raw`
(() => {
  window.__privatePerfInteractiveAt = undefined;
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  };
  const inspect = () => {
    if (window.__privatePerfInteractiveAt !== undefined) return;
    const heading = [...document.querySelectorAll("h1")].find((node) => node.textContent === "AI Assistant");
    const input = document.querySelector('input[aria-label="Message"]');
    if (!visible(heading) || !visible(input) || input.disabled) return;
    requestAnimationFrame(() => {
      if (visible(heading) && visible(input) && !input.disabled && window.__privatePerfInteractiveAt === undefined) {
        window.__privatePerfInteractiveAt = performance.now();
      }
    });
  };
  const observer = new MutationObserver(inspect);
  const start = () => {
    if (!document.documentElement) {
      setTimeout(start, 0);
      return;
    }
    observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
    inspect();
  };
  start();
})();`;

const STATUS_PROBE_SCRIPT = String.raw`
(() => {
  window.__privatePerfStatusMs = undefined;
  const form = document.querySelector('form[aria-label="Send a message to the assistant"]');
  if (!form) throw new Error("status_probe_form_missing");
  form.addEventListener("submit", () => {
    const startedAt = performance.now();
    const inspect = () => {
      const label = document.querySelector(".typing-label");
      const style = label ? getComputedStyle(label) : undefined;
      if (
        label?.textContent === "Understanding your request…"
        && style?.display !== "none"
        && style?.visibility !== "hidden"
        && label.getClientRects().length > 0
      ) {
        window.__privatePerfStatusMs = performance.now() - startedAt;
      }
    };
    const observer = new MutationObserver(() => {
      inspect();
      if (window.__privatePerfStatusMs !== undefined) observer.disconnect();
    });
    observer.observe(document.documentElement, { attributes: true, childList: true, characterData: true, subtree: true });
    inspect();
  }, { capture: true, once: true });
})();`;

declare global {
  interface Window {
    __privatePerfInteractiveAt?: number;
    __privatePerfStatusMs?: number;
  }
}

type JsonObject = Record<string, unknown>;

type GateFailureCode =
  | "attestation_failed"
  | "browser_failed"
  | "component_unavailable"
  | "session_unavailable"
  | "permission_not_ready"
  | "protocol_invalid"
  | "status_probe_failed"
  | "chat_turn_failed"
  | "resource_create_failed"
  | "delete_preview_failed"
  | "confirmation_failed"
  | "history_failed"
  | "cleanup_unproven"
  | "evidence_write_failed"
  | "unexpected_failure";

class GateFailure extends Error {
  constructor(readonly code: GateFailureCode) {
    super(code);
  }
}

interface LiveSession {
  context: BrowserContext;
  origin: string;
  csrfToken: string;
  expectedWorkspaceId: string;
}

interface PreviewHandle {
  id: string;
  nonce: string;
}

interface SyntheticResource {
  name: string;
  id?: string;
  undoId?: string;
  createdObserved: boolean;
  deletionProven: boolean;
  pendingPreview?: PreviewHandle;
}

interface ConfirmationMeasurement {
  firstReceiptMs: number;
  receipt: JsonObject;
}

function fail(code: GateFailureCode): never {
  throw new GateFailure(code);
}

function safeFailureCode(error: unknown): GateFailureCode {
  return error instanceof GateFailure ? error.code : "unexpected_failure";
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    fail("attestation_failed");
  }
}

function gitRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    fail("attestation_failed");
  }
}

function requireCleanReleaseCheckout(): void {
  try {
    if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) {
      fail("attestation_failed");
    }
  } catch (error) {
    if (error instanceof GateFailure) throw error;
    fail("attestation_failed");
  }
}

function browserEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL"]) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

function endpoint(origin: string, path: string): string {
  return new URL(path, origin).toString();
}

async function jsonBody(response: APIResponse): Promise<JsonObject> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    fail("protocol_invalid");
  }
  const parsed = object(value);
  if (!parsed) fail("protocol_invalid");
  return parsed;
}

async function refreshSession(session: LiveSession): Promise<void> {
  let response: APIResponse;
  try {
    response = await session.context.request.get(endpoint(session.origin, "/api/me"), {
      timeout: HTTP_TIMEOUT_MS,
    });
  } catch {
    fail("session_unavailable");
  }
  if (!response.ok()) fail("session_unavailable");
  const body = await jsonBody(response);
  const csrfToken = nonEmptyString(body.csrfToken);
  if (body.ok !== true || body.workspaceId !== session.expectedWorkspaceId || !csrfToken) {
    fail("session_unavailable");
  }
  session.csrfToken = csrfToken;
}

async function requireDeployedRelease(
  session: LiveSession,
  releaseSha: string,
  releaseBuildHash: string,
): Promise<DeployedReleaseBinding> {
  let response: APIResponse;
  try {
    response = await session.context.request.get(endpoint(session.origin, "/version"), {
      timeout: HTTP_TIMEOUT_MS,
    });
  } catch {
    fail("attestation_failed");
  }
  if (!response.ok()) fail("attestation_failed");
  try {
    return validateDeployedRelease(await response.json() as unknown, releaseSha, releaseBuildHash);
  } catch {
    fail("attestation_failed");
  }
}

async function requireReadyPermissions(session: LiveSession): Promise<void> {
  let response: APIResponse;
  try {
    response = await session.context.request.get(endpoint(session.origin, "/api/permissions"), {
      timeout: HTTP_TIMEOUT_MS,
    });
  } catch {
    fail("permission_not_ready");
  }
  if (!response.ok()) fail("permission_not_ready");
  const body = await jsonBody(response);
  const policy = object(body.policy);
  const groups = object(policy?.groups);
  if (body.ok !== true || body.firstRun !== false || groups?.work_structure !== "read_write") {
    fail("permission_not_ready");
  }
}

async function pendingPreviews(session: LiveSession): Promise<JsonObject[]> {
  let response: APIResponse;
  try {
    response = await session.context.request.get(endpoint(session.origin, "/api/chat/history"), {
      timeout: HTTP_TIMEOUT_MS,
    });
  } catch {
    fail("history_failed");
  }
  if (!response.ok()) fail("history_failed");
  const body = await jsonBody(response);
  if (body.ok !== true || !Array.isArray(body.pendingPreviews)) fail("history_failed");
  const previews = body.pendingPreviews.map((value) => object(value));
  if (previews.some((value) => value === undefined)) fail("protocol_invalid");
  return previews as JsonObject[];
}

async function cancelGatePreviews(session: LiveSession): Promise<void> {
  for (const preview of await pendingPreviews(session)) {
    const id = nonEmptyString(preview.previewId);
    if (!id) fail("protocol_invalid");
    let response: APIResponse;
    try {
      response = await session.context.request.post(
        endpoint(session.origin, `/api/confirmations/${encodeURIComponent(id)}/cancel`),
        {
          headers: {
            "content-type": "application/json",
            "x-csrf-token": session.csrfToken,
          },
          data: {},
          timeout: HTTP_TIMEOUT_MS,
        },
      );
    } catch {
      fail("cleanup_unproven");
    }
    if (!response.ok()) fail("cleanup_unproven");
    const body = await jsonBody(response);
    if (body.ok !== true || body.status !== "cancelled") fail("cleanup_unproven");
  }
  if ((await pendingPreviews(session)).length !== 0) fail("cleanup_unproven");
}

async function navigateToComponent(page: Page, componentUrl: string): Promise<number> {
  let response: Awaited<ReturnType<Page["goto"]>>;
  try {
    response = await page.goto(componentUrl, { waitUntil: "domcontentloaded", timeout: HTTP_TIMEOUT_MS });
    if (!response?.ok()) fail("component_unavailable");
    await page.waitForFunction("window.__privatePerfInteractiveAt !== undefined", undefined, { timeout: HTTP_TIMEOUT_MS });
    const measured = await page.evaluate(() => window.__privatePerfInteractiveAt);
    if (typeof measured !== "number" || !Number.isFinite(measured) || measured < 0) fail("protocol_invalid");
    return measured;
  } catch (error) {
    if (error instanceof GateFailure) throw error;
    fail("component_unavailable");
  }
}

async function measureWarmIframe(page: Page, componentUrl: string): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < PRIVATE_PRODUCTION_SAMPLE_COUNTS.warmIframeInteractive; index += 1) {
    samples.push(await navigateToComponent(page, componentUrl));
  }
  return samples;
}

async function measureColdFast4g(browser: Browser, componentUrl: string): Promise<number[]> {
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    await page.addInitScript({ content: SHELL_PROBE_SCRIPT });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: FAST_4G_PROFILE.latencyMs,
      downloadThroughput: FAST_4G_PROFILE.downloadBitsPerSecond / 8,
      uploadThroughput: FAST_4G_PROFILE.uploadBitsPerSecond / 8,
      connectionType: "cellular4g",
    });
    const samples: number[] = [];
    for (let index = 0; index < PRIVATE_PRODUCTION_SAMPLE_COUNTS.coldFast4gInteractive; index += 1) {
      samples.push(await navigateToComponent(page, componentUrl));
    }
    return samples;
  } finally {
    await context.close();
  }
}

async function measureLocalStatus(page: Page): Promise<number[]> {
  await page.route(STATUS_STREAM_PATTERN, async (route) => {
    await delay(200);
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson; charset=utf-8",
      headers: { "cache-control": "no-store" },
      body: `${JSON.stringify({ type: "reply", kind: "answer", text: "Complete." })}\n${JSON.stringify({ type: "done" })}\n`,
    });
  });
  const samples: number[] = [];
  try {
    const input = page.locator('input[aria-label="Message"]');
    await input.waitFor({ state: "visible", timeout: HTTP_TIMEOUT_MS });
    for (let index = 0; index < PRIVATE_PRODUCTION_SAMPLE_COUNTS.localStatus; index += 1) {
      await input.fill(`private-status-${index}`);
      await page.evaluate(STATUS_PROBE_SCRIPT);
      await input.press("Enter");
      try {
        await page.waitForFunction("window.__privatePerfStatusMs !== undefined", undefined, { timeout: 2_000 });
      } catch {
        fail("status_probe_failed");
      }
      const measured = await page.evaluate(() => window.__privatePerfStatusMs);
      if (typeof measured !== "number" || !Number.isFinite(measured) || measured < 0) {
        fail("status_probe_failed");
      }
      samples.push(measured);
      await page.waitForFunction(() => {
        const composer = document.querySelector<HTMLInputElement>('input[aria-label="Message"]');
        return composer !== null && !composer.disabled;
      }, undefined, { timeout: HTTP_TIMEOUT_MS });
    }
  } finally {
    await page.unroute(STATUS_STREAM_PATTERN);
  }
  return samples;
}

function parseNdjson(text: string): JsonObject[] {
  const events: JsonObject[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      fail("protocol_invalid");
    }
    const event = object(value);
    if (!event) fail("protocol_invalid");
    events.push(event);
  }
  if (!events.some((event) => event.type === "done")) fail("protocol_invalid");
  if (events.some((event) => event.type === "error")) fail("chat_turn_failed");
  return events;
}

async function chat(session: LiveSession, message: string): Promise<JsonObject[]> {
  let response: APIResponse;
  try {
    response = await session.context.request.post(endpoint(session.origin, "/api/chat/stream"), {
      headers: {
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
      },
      data: { message, requestId: randomUUID() },
      timeout: CHAT_TIMEOUT_MS,
    });
  } catch {
    fail("chat_turn_failed");
  }
  if (!response.ok()) fail("chat_turn_failed");
  let text: string;
  try {
    text = await response.text();
  } catch {
    fail("chat_turn_failed");
  }
  return parseNdjson(text);
}

function receiptFor(events: JsonObject[], action: string): JsonObject | undefined {
  for (const event of events) {
    if (event.type !== "result") continue;
    const result = object(event.result);
    const receipt = object(result?.receipt);
    if (result?.kind === "receipt" && receipt?.action === action) return receipt;
  }
  return undefined;
}

function previewFor(events: JsonObject[]): PreviewHandle | undefined {
  for (const event of events) {
    if (event.type !== "result") continue;
    const result = object(event.result);
    if (result?.kind !== "preview") continue;
    const id = nonEmptyString(result.previewId);
    const nonce = nonEmptyString(result.nonce);
    if (id && nonce) return { id, nonce };
  }
  return undefined;
}

function createdTag(receipt: JsonObject, expectedName: string): { id: string } | undefined {
  if (receipt.ok !== true || receipt.action !== "clockify_tags_create") return undefined;
  const changed = object(receipt.changed);
  if (!Array.isArray(changed?.created) || changed.created.length !== 1) return undefined;
  const created = object(changed.created[0]);
  const id = nonEmptyString(created?.id);
  if (created?.type !== "tag" || created?.name !== expectedName || !id) return undefined;
  return { id };
}

function undoIdFor(events: JsonObject[], action: string): string | undefined {
  for (const event of events) {
    if (event.type !== "result") continue;
    const result = object(event.result);
    const receipt = object(result?.receipt);
    const undo = object(result?.undo);
    if (result?.kind === "receipt" && receipt?.action === action) return nonEmptyString(undo?.id);
  }
  return undefined;
}

async function createSyntheticResource(session: LiveSession, resource: SyntheticResource): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const events = await chat(
      session,
      `Create exactly one Clockify tag named "${resource.name}". Call clockify_tags_create exactly once with name "${resource.name}" now.`,
    );
    const receipt = receiptFor(events, "clockify_tags_create");
    if (!receipt) continue;
    const created = createdTag(receipt, resource.name);
    const undoId = undoIdFor(events, "clockify_tags_create");
    if (created) resource.id = created.id;
    if (undoId) resource.undoId = undoId;
    if (!created || !undoId) fail("resource_create_failed");
    resource.createdObserved = true;
    return;
  }
  fail("resource_create_failed");
}

async function requestDeletePreview(session: LiveSession, resource: SyntheticResource): Promise<PreviewHandle> {
  const identity = resource.id
    ? `with exact id "${resource.id}" and name "${resource.name}"`
    : `named "${resource.name}"`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const events = await chat(
      session,
      `Delete the Clockify tag ${identity}. Call clockify_tags_delete exactly once now and return its required preview.`,
    );
    const preview = previewFor(events);
    if (preview) {
      resource.pendingPreview = preview;
      return preview;
    }
  }
  fail("delete_preview_failed");
}

async function sessionCookie(context: BrowserContext, origin: string): Promise<string> {
  const cookies = await context.cookies(origin);
  const session = cookies.find((cookie) => cookie.name === "ai_assistant_session");
  if (!session?.value) fail("session_unavailable");
  return `${session.name}=${session.value}`;
}

function parseStreamLine(line: string): JsonObject | undefined {
  if (!line.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    fail("protocol_invalid");
  }
  const event = object(value);
  if (!event) fail("protocol_invalid");
  return event;
}

async function confirmPreview(
  session: LiveSession,
  preview: PreviewHandle,
): Promise<ConfirmationMeasurement> {
  const cookie = await sessionCookie(session.context, session.origin);
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(endpoint(session.origin, `/api/confirmations/${encodeURIComponent(preview.id)}/confirm?stream=1`), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
        cookie,
      },
      body: JSON.stringify({ nonce: preview.nonce }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
  } catch {
    fail("confirmation_failed");
  }
  if (!response.ok || !response.body) fail("confirmation_failed");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receipt: JsonObject | undefined;
  let firstReceiptMs: number | undefined;
  let done = false;

  const accept = (event: JsonObject | undefined): void => {
    if (!event) return;
    if (event.type === "receipt" && !receipt) {
      const parsedReceipt = object(event.receipt);
      if (!parsedReceipt) fail("protocol_invalid");
      receipt = parsedReceipt;
      firstReceiptMs = performance.now() - startedAt;
    }
    if (event.type === "error" && !receipt) fail("confirmation_failed");
    if (event.type === "done") done = true;
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        accept(parseStreamLine(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    accept(parseStreamLine(buffer));
  } catch (error) {
    if (error instanceof GateFailure) throw error;
    fail("confirmation_failed");
  }
  if (!done || !receipt || firstReceiptMs === undefined) fail("confirmation_failed");
  return { firstReceiptMs, receipt };
}

function deletionMatches(receipt: JsonObject, resource: SyntheticResource): boolean {
  if (receipt.ok !== true || receipt.action !== "clockify_tags_delete") return false;
  const changed = object(receipt.changed);
  if (!Array.isArray(changed?.deleted) || changed.deleted.length !== 1) return false;
  const deleted = object(changed.deleted[0]);
  if (deleted?.type !== "tag") return false;
  if (resource.id && deleted?.id !== resource.id) return false;
  if (!resource.id && deleted?.name !== resource.name) return false;
  const deletedId = nonEmptyString(deleted?.id);
  if (!deletedId) return false;
  resource.id = deletedId;
  return true;
}

async function rotateChatSession(session: LiveSession): Promise<void> {
  let response: APIResponse;
  try {
    response = await session.context.request.post(endpoint(session.origin, "/api/chat/new"), {
      headers: {
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
      },
      data: {},
      timeout: HTTP_TIMEOUT_MS,
    });
  } catch {
    fail("session_unavailable");
  }
  if (!response.ok()) fail("session_unavailable");
  const body = await jsonBody(response);
  if (body.ok !== true) fail("session_unavailable");
  await refreshSession(session);
}

async function seedSupportedHistory(session: LiveSession): Promise<void> {
  // One user + one assistant row per completed turn: 25 read-only turns fill
  // the exact supported 50-message restore window while remaining below the
  // default 30-turn/5m paid-model limiter.
  for (let index = 0; index < 25; index += 1) {
    await chat(
      session,
      `Read the assistant status for supported-history sample ${index + 1}. Do not perform any write.`,
    );
  }
}

async function measureHistoryApi(session: LiveSession): Promise<{ samples: number[]; pendingPreviews: number }> {
  const samples: number[] = [];
  let pendingPreviews = 0;
  for (let index = 0; index < PRIVATE_PRODUCTION_SAMPLE_COUNTS.historyApi; index += 1) {
    const startedAt = performance.now();
    let response: APIResponse;
    try {
      response = await session.context.request.get(endpoint(session.origin, "/api/chat/history"), {
        timeout: HTTP_TIMEOUT_MS,
      });
    } catch {
      fail("history_failed");
    }
    if (!response.ok()) fail("history_failed");
    const body = await jsonBody(response);
    const messages = body.messages;
    const pending = body.pendingPreviews;
    if (body.ok !== true || !Array.isArray(messages) || messages.length !== 50 || !Array.isArray(pending)) {
      fail("history_failed");
    }
    pendingPreviews = pending.length;
    if (pendingPreviews !== 0) fail("cleanup_unproven");
    samples.push(performance.now() - startedAt);
  }
  return { samples, pendingPreviews };
}

async function proveResourceAbsent(session: LiveSession, resource: SyntheticResource): Promise<boolean> {
  let events: JsonObject[];
  try {
    events = await chat(
      session,
      `List Clockify tags filtered to the exact name "${resource.name}". Call clockify_tags_list exactly once with name "${resource.name}".`,
    );
  } catch {
    return false;
  }
  const receipt = receiptFor(events, "clockify_tags_list");
  const data = object(receipt?.data);
  if (receipt?.ok !== true || data?.truncated !== false || !Array.isArray(data.items)) return false;
  const exact = data.items
    .map((item) => object(item))
    .filter((item): item is JsonObject => item !== undefined && item.name === resource.name);
  if (exact.length === 0) return true;
  if (exact.length === 1) {
    const id = nonEmptyString(exact[0].id);
    if (id) resource.id = id;
  }
  return false;
}

async function undoSyntheticResource(session: LiveSession, resource: SyntheticResource): Promise<boolean> {
  if (!resource.undoId) return false;
  let response: APIResponse;
  try {
    response = await session.context.request.post(
      endpoint(session.origin, `/api/undo/${encodeURIComponent(resource.undoId)}`),
      {
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
        },
        data: {},
        timeout: HTTP_TIMEOUT_MS,
      },
    );
  } catch {
    return false;
  }
  if (!response.ok()) return false;
  const body = await jsonBody(response);
  const receipt = object(body.receipt);
  const changed = object(receipt?.changed);
  if (body.ok !== true || receipt?.ok !== true || receipt.action !== "undo" || !Array.isArray(changed?.deleted)) {
    return false;
  }
  const matched = changed.deleted.some((value) => {
    const deleted = object(value);
    return deleted?.type === "tag" && (resource.id ? deleted.id === resource.id : deleted.name === resource.name);
  });
  if (matched) resource.undoId = undefined;
  return matched;
}

/** Best-effort repair is itself fail-closed: success means receipt- or complete-list proof. */
async function cleanupOutstanding(session: LiveSession, resources: SyntheticResource[]): Promise<void> {
  for (const resource of resources) {
    if (resource.deletionProven) continue;
    // The safe-create receipt carries a one-use undo handle. This path bypasses
    // DeepSeek entirely, so provider failure cannot strand a synthetic tag.
    if (await undoSyntheticResource(session, resource)) {
      resource.deletionProven = true;
      resource.pendingPreview = undefined;
      continue;
    }
    for (let attempt = 0; attempt < 3 && !resource.deletionProven; attempt += 1) {
      try {
        const preview = resource.pendingPreview ?? await requestDeletePreview(session, resource);
        const confirmed = await confirmPreview(session, preview);
        resource.pendingPreview = undefined;
        if (deletionMatches(confirmed.receipt, resource)) {
          resource.deletionProven = true;
          break;
        }
      } catch {
        // A dispatched delete may have settled even if its stream broke. A complete
        // exact-name list is the only accepted absence proof in that case.
        if (attempt > 0) resource.pendingPreview = undefined;
      }
      if (await proveResourceAbsent(session, resource)) {
        resource.deletionProven = true;
        resource.pendingPreview = undefined;
      }
    }
    if (!resource.deletionProven) fail("cleanup_unproven");
  }
}

async function writeEvidence(
  environment: PrivateProductionEnvironment,
  generatedAt: string,
  evidence: ReturnType<typeof buildPrivateProductionEvidence>,
): Promise<void> {
  const directory = resolve(environment.evidenceDirectory);
  const stamp = generatedAt.replace(/\D/g, "").slice(0, 14);
  const basename = `private-production-${environment.releaseSha.slice(0, 12)}-${stamp}`;
  try {
    await mkdir(directory, { recursive: true });
    const [realDirectory, realWorktree] = await Promise.all([
      realpath(directory),
      realpath(environment.worktreeRoot),
    ]);
    if (!isOutsideWorktree(realDirectory, realWorktree)) fail("evidence_write_failed");
    await Promise.all([
      writeFile(join(directory, `${basename}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8"),
      writeFile(join(directory, `${basename}.md`), renderPrivateProductionMarkdown(evidence), "utf8"),
    ]);
  } catch {
    fail("evidence_write_failed");
  }
}

async function runGate(environment: PrivateProductionEnvironment): Promise<void> {
  if (process.versions.node.split(".")[0] !== "22") fail("attestation_failed");
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  const resources: SyntheticResource[] = [];
  let session: LiveSession | undefined;
  let gateOwnsPendingPreviews = false;
  let primaryFailure: unknown;
  try {
    // Do not inherit the Node process environment: the authenticated component
    // address is intentionally available only to this process, never a child.
    browser = await chromium.launch({ headless: true, env: browserEnvironment() });
    context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    await page.addInitScript({ content: SHELL_PROBE_SCRIPT });
    await navigateToComponent(page, environment.componentUrl);
    session = {
      context,
      origin: new URL(environment.componentUrl).origin,
      csrfToken: "",
      expectedWorkspaceId: environment.expectedWorkspaceId,
    };
    await refreshSession(session);
    const deployed = await requireDeployedRelease(session, environment.releaseSha, environment.releaseBuildHash);
    await requireReadyPermissions(session);
    if ((await pendingPreviews(session)).length !== 0) fail("cleanup_unproven");
    gateOwnsPendingPreviews = true;
    const measurementStartedAt = new Date().toISOString();

    process.stdout.write("Measuring private-production local status feedback…\n");
    const localStatusMs = await measureLocalStatus(page);
    process.stdout.write("Measuring private-production warm iframe interactivity…\n");
    const warmIframeInteractiveMs = await measureWarmIframe(page, environment.componentUrl);
    process.stdout.write("Measuring private-production cold fast-4G interactivity…\n");
    const coldFast4gInteractiveMs = await measureColdFast4g(browser, environment.componentUrl);

    process.stdout.write("Measuring private-production history at the exact supported limit…\n");
    await seedSupportedHistory(session);
    const history = await measureHistoryApi(session);
    await rotateChatSession(session);

    process.stdout.write("Measuring private-production confirmation receipts with self-cleaning synthetic resources…\n");
    const confirmationFirstReceiptMs: number[] = [];
    for (let index = 0; index < PRIVATE_PRODUCTION_SAMPLE_COUNTS.confirmationFirstReceipt; index += 1) {
      const resource: SyntheticResource = {
        name: `${RESOURCE_PREFIX}${randomUUID().replaceAll("-", "").slice(0, 20)}`,
        createdObserved: false,
        deletionProven: false,
      };
      resources.push(resource);
      await createSyntheticResource(session, resource);
      const preview = await requestDeletePreview(session, resource);
      const confirmed = await confirmPreview(session, preview);
      resource.pendingPreview = undefined;
      if (!deletionMatches(confirmed.receipt, resource)) fail("confirmation_failed");
      resource.deletionProven = true;
      confirmationFirstReceiptMs.push(confirmed.firstReceiptMs);

      // Five samples are ten nominal and at most twenty retried model-backed
      // turns, preserving cleanup headroom beneath the default 30/5m cap.
      if (index === 4 || index === 9 || index === 14) {
        await rotateChatSession(session);
      }
    }

    await cleanupOutstanding(session, resources);
    const finalPendingPreviews = (await pendingPreviews(session)).length;
    if (finalPendingPreviews !== 0) fail("cleanup_unproven");
    const generatedAt = new Date().toISOString();
    const evidence = buildPrivateProductionEvidence({
      measurementStartedAt,
      generatedAt,
      commitSha: environment.releaseSha,
      deployed,
      node: process.version,
      browserVersion: browser.version(),
      samples: {
        warmIframeInteractiveMs,
        coldFast4gInteractiveMs,
        historyApiMs: history.samples,
        localStatusMs,
        confirmationFirstReceiptMs,
      },
      cleanup: {
        created: resources.filter((resource) => resource.createdObserved).length,
        deletionProven: resources.filter((resource) => resource.createdObserved && resource.deletionProven).length,
        pendingPreviews: finalPendingPreviews,
      },
    });
    await writeEvidence(environment, generatedAt, evidence);
    process.stdout.write(
      `Private-production performance ${evidence.conclusion.toUpperCase()}: `+
      `warm p95 ${evidence.metrics.warmIframeInteractive.p95Ms}ms; `+
      `cold p95 ${evidence.metrics.coldFast4gInteractive.p95Ms}ms; `+
      `history p95 ${evidence.metrics.historyApi.p95Ms}ms; `+
      `status max ${evidence.metrics.localStatus.maxMs}ms; `+
      `confirmation p95 ${evidence.metrics.confirmationFirstReceipt.p95Ms}ms; `+
      `cleanup ${evidence.cleanup.deletionProven}/${evidence.cleanup.created}.\n`,
    );
    if (evidence.conclusion !== "passed") process.exitCode = 1;
  } catch (error) {
    primaryFailure = error;
    if (session) {
      try {
        await refreshSession(session);
        await cleanupOutstanding(session, resources);
        if (gateOwnsPendingPreviews) await cancelGatePreviews(session);
      } catch {
        primaryFailure = new GateFailure("cleanup_unproven");
      }
    }
  } finally {
    await context?.close();
    await browser?.close();
  }
  if (primaryFailure instanceof Error) throw primaryFailure;
  if (primaryFailure !== undefined) fail("unexpected_failure");
}

async function main(): Promise<void> {
  let environment: PrivateProductionEnvironment;
  try {
    environment = validatePrivateProductionEnvironment(process.env, gitHead(), gitRoot());
    requireCleanReleaseCheckout();
  } catch {
    fail("attestation_failed");
  }
  await runGate(environment);
}

void main().catch((error: unknown) => {
  // Deliberately emit only a fixed code. Playwright/fetch errors can embed the
  // private component address; model/Clockify errors can embed resource data.
  process.stderr.write(`Private-production performance gate failed safely (${safeFailureCode(error)}).\n`);
  process.exitCode = 1;
});
