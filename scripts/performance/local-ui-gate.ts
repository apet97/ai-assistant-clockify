import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { chromium, type Browser, type Page } from "@playwright/test";

import {
  FAST_4G_PROFILE,
  LOCAL_UI_SAMPLE_COUNTS,
  LOCAL_UI_THRESHOLDS,
  evaluateLocalUiEvidence,
  renderLocalUiMarkdown,
  summarize,
  type AssetGzipResult,
  type LocalUiEvidence,
} from "./local-ui-contract.js";

const PORT = 4187;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const HISTORY_LIMIT = 50;
const STATUS_RESPONSE_DELAY_MS = 175;
const EVIDENCE_BASENAME = "local-ui-2026-07-18";

interface HistoryProbe {
  requestStartedAt: number;
  responseReceivedAt: number;
  hydratedAt: number;
}

// `tsx` names nested functions with an internal `__name` helper. Playwright
// serializes browser callbacks without that module helper, so non-trivial probe
// programs are explicit strings. This also makes their browser boundary plain:
// no Node values or environment can leak into the fixture page.
const SHELL_PROBE_SCRIPT = String.raw`
(() => {
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  };
  const inspect = () => {
    if (window.__perfShellInteractiveAt !== undefined) return;
    const heading = [...document.querySelectorAll("h1")].find((node) => node.textContent === "AI Assistant") ?? null;
    const input = document.querySelector('input[aria-label="Message"]');
    if (!visible(heading) || !visible(input) || input.disabled) return;
    requestAnimationFrame(() => {
      if (visible(heading) && visible(input) && !input.disabled && window.__perfShellInteractiveAt === undefined) {
        window.__perfShellInteractiveAt = performance.now();
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

const STATUS_ARM_SCRIPT = String.raw`
(() => {
  window.__perfStatusResult = undefined;
  window.__perfStatusSubmitObserved = false;
  const form = document.querySelector('form[aria-label="Send a message to the assistant"]');
  if (!form) throw new Error("Composer form is unavailable.");
  form.addEventListener("submit", () => {
    window.__perfStatusSubmitObserved = true;
    const startedAt = performance.now();
    const inspect = () => {
      const label = document.querySelector(".typing-label");
      const style = label ? getComputedStyle(label) : undefined;
      window.__perfStatusInspection = {
        text: label?.textContent,
        display: style?.display,
        visibility: style?.visibility,
        rects: label?.getClientRects().length,
      };
      if (
        label?.textContent === "Understanding your request…"
        && style?.display !== "none"
        && style?.visibility !== "hidden"
        && label.getClientRects().length > 0
      ) {
        window.__perfStatusResult = performance.now() - startedAt;
      }
    };
    const observer = new MutationObserver(() => {
      inspect();
      if (window.__perfStatusResult !== undefined) observer.disconnect();
    });
    observer.observe(document.documentElement, { attributes: true, childList: true, characterData: true, subtree: true });
    inspect();
  }, { capture: true, once: true });
})();`;

const HISTORY_PROBE_SCRIPT = String.raw`
(() => {
  const expectedMessages = ${HISTORY_LIMIT};
  window.__perfHistory = {};
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const raw = args[0];
    const url = typeof raw === "string" ? raw : raw instanceof URL ? raw.href : raw.url;
    const isHistory = new URL(url, location.href).pathname === "/api/chat/history";
    if (isHistory) window.__perfHistory.requestStartedAt = performance.now();
    const response = await nativeFetch(...args);
    if (isHistory) window.__perfHistory.responseReceivedAt = performance.now();
    return response;
  };
  const inspect = () => {
    if (window.__perfHistory?.hydratedAt !== undefined) return;
    const messages = document.querySelectorAll(".messages > .message.user, .messages > .message.assistant:not(.typing)");
    if (messages.length < expectedMessages || window.__perfHistory?.responseReceivedAt === undefined) return;
    requestAnimationFrame(() => {
      if (document.querySelectorAll(".messages > .message.user, .messages > .message.assistant:not(.typing)").length >= expectedMessages) {
        window.__perfHistory.hydratedAt = performance.now();
      }
    });
  };
  const observer = new MutationObserver(inspect);
  const start = () => {
    if (!document.documentElement) {
      setTimeout(start, 0);
      return;
    }
    observer.observe(document.documentElement, { childList: true, subtree: true });
    inspect();
  };
  start();
})();`;

declare global {
  interface Window {
    __perfShellInteractiveAt?: number;
    __perfStatusResult?: number;
    __perfStatusSubmitObserved?: boolean;
    __perfStatusInspection?: Record<string, unknown>;
    __perfHistory?: Partial<HistoryProbe>;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFixture(child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Performance fixture exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${BASE_URL}/healthz`);
      if (response.ok) return;
    } catch {
      // The fixture is still starting.
    }
    await delay(50);
  }
  throw new Error("Performance fixture did not become ready within 5 seconds.");
}

async function stopFixture(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(2_000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function installShellProbe(page: Page): Promise<void> {
  await page.addInitScript({ content: SHELL_PROBE_SCRIPT });
}

async function shellInteractiveMs(page: Page, suffix: string): Promise<number> {
  await page.goto(`${BASE_URL}/?perf=${encodeURIComponent(suffix)}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__perfShellInteractiveAt !== undefined);
  return await page.evaluate(() => window.__perfShellInteractiveAt as number);
}

async function measureWarmShell(browser: Browser): Promise<number[]> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await installShellProbe(page);
  await shellInteractiveMs(page, "warm-prime");
  const samples: number[] = [];
  for (let index = 0; index < LOCAL_UI_SAMPLE_COUNTS.warmShell; index += 1) {
    samples.push(await shellInteractiveMs(page, `warm-${index}`));
  }
  await context.close();
  return samples;
}

async function measureColdFast4gShell(browser: Browser): Promise<number[]> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await installShellProbe(page);
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
  for (let index = 0; index < LOCAL_UI_SAMPLE_COUNTS.coldFast4gShell; index += 1) {
    await context.clearCookies();
    samples.push(await shellInteractiveMs(page, `cold-fast4g-${index}`));
  }
  await context.close();
  return samples;
}

async function measureStatusFeedback(browser: Browser): Promise<number[]> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let interceptedStreams = 0;
  await page.route("**/api/chat/stream", async (route) => {
    interceptedStreams += 1;
    await delay(STATUS_RESPONSE_DELAY_MS);
    await route.continue();
  });
  await page.goto(`${BASE_URL}/?perf=status`, { waitUntil: "domcontentloaded" });
  const input = page.locator('input[aria-label="Message"]');
  await input.waitFor({ state: "visible" });
  const samples: number[] = [];
  for (let index = 0; index < LOCAL_UI_SAMPLE_COUNTS.statusFeedback; index += 1) {
    await input.fill(`status-${index}`);
    await page.evaluate(STATUS_ARM_SCRIPT);
    await input.press("Enter");
    try {
      await page.waitForFunction(() => window.__perfStatusResult !== undefined, undefined, { timeout: 5_000 });
    } catch {
      const state = await page.evaluate(() => ({
        inputDisabled: document.querySelector<HTMLInputElement>('input[aria-label="Message"]')?.disabled,
        typingConnected: document.querySelector(".typing")?.isConnected,
        typingText: document.querySelector(".typing-label")?.textContent,
        errorText: document.querySelector(".error")?.textContent,
        submitObserved: window.__perfStatusSubmitObserved,
        inspection: window.__perfStatusInspection,
      }));
      throw new Error(`Status sample ${index + 1} was not observed after ${interceptedStreams} intercepted streams: ${JSON.stringify({ ...state, pageErrors })}`);
    }
    samples.push(await page.evaluate(() => window.__perfStatusResult as number));
    await input.waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const composer = document.querySelector<HTMLInputElement>('input[aria-label="Message"]');
      return composer !== null && !composer.disabled;
    });
  }
  await context.close();
  return samples;
}

function historyMessages(): Array<{ role: "user" | "assistant"; content: string }> {
  return Array.from({ length: HISTORY_LIMIT }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Performance history message ${index + 1}: deterministic bounded restore payload.`,
  }));
}

async function installHistoryProbe(page: Page): Promise<void> {
  await page.addInitScript({ content: HISTORY_PROBE_SCRIPT });
}

async function measureHistoryHydration(browser: Browser): Promise<{
  total: number[];
  response: number[];
  renderAfterResponse: number[];
}> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/api/chat/history", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({ ok: true, messages: historyMessages(), pendingPreviews: [], operationRuns: [] }),
    });
  });
  await installHistoryProbe(page);
  const total: number[] = [];
  const response: number[] = [];
  const renderAfterResponse: number[] = [];
  for (let index = 0; index < LOCAL_UI_SAMPLE_COUNTS.historyHydration; index += 1) {
    await page.goto(`${BASE_URL}/?perf=history-${index}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction((expected) => {
      const probe = window.__perfHistory;
      return probe?.requestStartedAt !== undefined
        && probe.responseReceivedAt !== undefined
        && probe.hydratedAt !== undefined
        && document.querySelectorAll(".messages > .message.user, .messages > .message.assistant:not(.typing)").length >= expected;
    }, HISTORY_LIMIT);
    const probe = await page.evaluate(() => window.__perfHistory as HistoryProbe);
    total.push(probe.hydratedAt - probe.requestStartedAt);
    response.push(probe.responseReceivedAt - probe.requestStartedAt);
    renderAfterResponse.push(probe.hydratedAt - probe.responseReceivedAt);
  }
  await context.close();
  return { total, response, renderAfterResponse };
}

async function listBuiltAssets(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...await listBuiltAssets(path));
    else if (entry.isFile() && /\.(?:css|js)$/.test(entry.name)) paths.push(path);
  }
  return paths.sort();
}

async function measureAssets(): Promise<AssetGzipResult> {
  const root = join(process.cwd(), "dist", "ui");
  const paths = await listBuiltAssets(root);
  if (paths.length === 0) throw new Error("No built UI JavaScript or CSS assets found. Run npm run build first.");
  const files = await Promise.all(paths.map(async (path) => {
    const bytes = await readFile(path);
    return {
      path: relative(process.cwd(), path),
      rawBytes: bytes.byteLength,
      gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
    };
  }));
  const rawBytes = files.reduce((sum, file) => sum + file.rawBytes, 0);
  const gzipBytes = files.reduce((sum, file) => sum + file.gzipBytes, 0);
  return {
    files,
    rawBytes,
    gzipBytes,
    limitBytes: LOCAL_UI_THRESHOLDS.uiGzipBytes,
    passed: gzipBytes <= LOCAL_UI_THRESHOLDS.uiGzipBytes,
  };
}

function sourceMetadata(): LocalUiEvidence["source"] {
  return {
    commitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workingTreeDirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
  };
}

async function writeEvidence(evidence: LocalUiEvidence): Promise<void> {
  const directory = process.env.PERF_EVIDENCE_DIR
    ? resolve(process.env.PERF_EVIDENCE_DIR)
    : join(process.cwd(), "evidence", "performance");
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, `${EVIDENCE_BASENAME}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8"),
    writeFile(join(directory, `${EVIDENCE_BASENAME}.md`), renderLocalUiMarkdown(evidence), "utf8"),
  ]);
}

async function main(): Promise<void> {
  const fixture = spawn(process.execPath, ["tests/e2e/fixtures/server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, E2E_PORT: String(PORT) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let fixtureError = "";
  fixture.stderr?.on("data", (chunk: Buffer) => { fixtureError += chunk.toString("utf8"); });
  let browser: Browser | undefined;
  try {
    await waitForFixture(fixture);
    browser = await chromium.launch({ headless: true });
    const browserVersion = browser.version();
    // Run cohorts sequentially: parallel browser cohorts would contend for the
    // same CPU/network loop and turn the gate into a load test rather than a
    // reproducible single-iframe latency measurement.
    process.stdout.write("Measuring local visible status feedback…\n");
    const status = await measureStatusFeedback(browser);
    process.stdout.write("Measuring warm shell interactivity…\n");
    const warmShell = await measureWarmShell(browser);
    process.stdout.write("Measuring cold fast-4G shell interactivity…\n");
    const coldShell = await measureColdFast4gShell(browser);
    process.stdout.write("Measuring supported-limit history hydration…\n");
    const history = await measureHistoryHydration(browser);
    const uiAssets = await measureAssets();
    const statusFeedback = summarize(status);
    const warmShellInteractive = summarize(warmShell);
    const coldFast4gShellInteractive = summarize(coldShell);
    const historyHydration = summarize(history.total);
    const evidence = evaluateLocalUiEvidence({
      schemaVersion: 1,
      kind: "local_fixture_ui_performance",
      generatedAt: new Date().toISOString(),
      scope: {
        classification: "secret-free local Playwright fixture",
        productionClaim: false,
        fixture: "tests/e2e/fixtures/server.mjs",
        note: "Built UI with deterministic local API responses; not Railway, Clockify, DeepSeek, or real-network evidence.",
      },
      source: sourceMetadata(),
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        browser: "Chromium",
        browserVersion,
        networkProfile: FAST_4G_PROFILE,
      },
      sampleCounts: LOCAL_UI_SAMPLE_COUNTS,
      thresholds: LOCAL_UI_THRESHOLDS,
      metrics: {
        statusFeedback: {
          ...statusFeedback,
          thresholdMaxMs: LOCAL_UI_THRESHOLDS.statusFeedbackMaxMs,
          passed: statusFeedback.maxMs < LOCAL_UI_THRESHOLDS.statusFeedbackMaxMs,
        },
        warmShellInteractive: {
          ...warmShellInteractive,
          thresholdP95Ms: LOCAL_UI_THRESHOLDS.warmShellP95Ms,
          passed: warmShellInteractive.p95Ms < LOCAL_UI_THRESHOLDS.warmShellP95Ms,
        },
        coldFast4gShellInteractive: {
          ...coldFast4gShellInteractive,
          thresholdP95Ms: LOCAL_UI_THRESHOLDS.coldFast4gShellP95Ms,
          passed: coldFast4gShellInteractive.p95Ms < LOCAL_UI_THRESHOLDS.coldFast4gShellP95Ms,
        },
        historyHydration: {
          ...historyHydration,
          thresholdP95Ms: LOCAL_UI_THRESHOLDS.historyHydrationP95Ms,
          supportedMessages: HISTORY_LIMIT,
          response: summarize(history.response),
          renderAfterResponse: summarize(history.renderAfterResponse),
          passed: historyHydration.p95Ms < LOCAL_UI_THRESHOLDS.historyHydrationP95Ms,
        },
        uiAssets,
      },
    });
    await writeEvidence(evidence);
    process.stdout.write(
      `Local fixture UI performance ${evidence.conclusion.toUpperCase()}: `+
      `status max ${evidence.metrics.statusFeedback.maxMs}ms; `+
      `warm p95 ${evidence.metrics.warmShellInteractive.p95Ms}ms; `+
      `cold fast-4G p95 ${evidence.metrics.coldFast4gShellInteractive.p95Ms}ms; `+
      `history p95 ${evidence.metrics.historyHydration.p95Ms}ms; `+
      `UI gzip ${evidence.metrics.uiAssets.gzipBytes} bytes.\n`,
    );
    if (evidence.conclusion !== "passed") process.exitCode = 1;
  } finally {
    await browser?.close();
    await stopFixture(fixture);
    if (fixtureError.trim() && fixture.exitCode !== 0 && fixture.exitCode !== null) {
      process.stderr.write("The local performance fixture failed.\n");
    }
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`Local UI performance gate failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
