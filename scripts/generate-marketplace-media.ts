import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { FEATURE_GROUPS } from "../src/harness/permissions.js";
import {
  marketplaceAssetSetSha256,
  marketplaceCaptureSourceSha256,
} from "./evidence/marketplace-media-contract.js";

const execFileAsync = promisify(execFile);
const VIEWPORT = { width: 1440, height: 900 } as const;
const PORT = 4184;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const FIXED_NOW_ISO = "2026-07-18T14:25:00.000Z";
const FIXED_EXPIRY_ISO = "2026-07-18T14:30:00.000Z";
const OUTPUT_ROOT = resolve("docs/marketplace/assets");
const SCREENSHOT_ROOT = join(OUTPUT_ROOT, "screenshots");
const VIDEO_ROOT = join(OUTPUT_ROOT, "video");
const EVIDENCE_PATH = join(OUTPUT_ROOT, "asset-evidence.json");
const VISUAL_REVIEW_PATH = join(OUTPUT_ROOT, "media-engineering-review.json");
const ICON_SVG_PATH = join(OUTPUT_ROOT, "icon.svg");
const ICON_PNG_PATH = join(OUTPUT_ROOT, "icon.png");
const BANNER_SVG_PATH = join(OUTPUT_ROOT, "banner.svg");
const BANNER_PNG_PATH = join(OUTPUT_ROOT, "banner.png");

const screenshotFiles = [
  "01-first-run-permissions.png",
  "02-read-and-receipt.png",
  "03-risky-preview-confirm.png",
  "04-receipt-and-undo.png",
  "05-history-and-pdf-download.png",
] as const;

const prompts = {
  read: "Summarize my team's time today.",
  risky: "Rename Website launch to Website launch v2.",
  safe: "Start a timer for Website launch.",
  pdf: "Export invoice INV-42 as a PDF.",
} as const;

const fixtureMessages = new Map<string, string>([
  [prompts.read, "read"],
  [prompts.risky, "risky-confirm"],
  [prompts.safe, "safe"],
  [prompts.pdf, "pdf"],
]);

const demoSteps = [
  { step: 1, label: "First-run DeepSeek disclosure, permissions, and public links" },
  { step: 2, label: "Read-only request and receipt" },
  { step: 3, label: "Safe write and immediate receipt" },
  { step: 4, label: "Risky preview and button confirmation" },
  { step: 5, label: "Confirmed receipt and truthful undo" },
  { step: 6, label: "History reload and authenticated PDF action" },
  { step: 7, label: "Permission controls and member-denial statement" },
] as const;

interface StoryFrame {
  path: string;
  durationSeconds: number;
}

interface MediaEvidence {
  file: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  durationSeconds?: number;
}

interface MarketplaceMediaEvidence {
  schemaVersion: 2;
  source: "deterministic synthetic release-build fixture";
  liveConnectivityEvidence: false;
  containsSecrets: false;
  captureSourceSha256: string;
  visualReview: {
    artifact: "docs/marketplace/assets/media-engineering-review.json";
    requiredStatus: "passed";
  };
  reproducibility: {
    fixedClock: typeof FIXED_NOW_ISO;
    pngCanonicalization: "retain prior bytes only when every YUV pixel delta is at most 1";
    videoCanonicalization: "retain prior bytes only when dimensions and duration match, SSIM >= 0.99998, and PSNR >= 65 dB";
  };
  demoSteps: typeof demoSteps;
  assets: MediaEvidence[];
}

const visualReviewChecks = [
  "icon-boundary-and-alpha",
  "banner-copy-and-legibility",
  "all-permission-groups-visible",
  "screenshots-readable-and-secret-free",
  "video-storyboard-readable-and-secret-free",
] as const;

interface MediaEngineeringReview {
  schemaVersion: 1;
  status: "pending";
  captureSourceSha256: string;
  assetSetSha256: string;
  reviewer: null;
  reviewedAt: null;
  checks: Array<{ id: typeof visualReviewChecks[number]; status: "pending"; notes: null }>;
  instructions: string;
}

interface FixtureProcess {
  exitCode: number | null;
  stderr: NodeJS.ReadableStream;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function waitForFixture(server: FixtureProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  let serverOutput = "";
  server.stderr.on("data", (chunk: Buffer) => {
    serverOutput += chunk.toString("utf8");
  });
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Media fixture exited before becoming ready.\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/healthz`);
      if (response.ok) return;
    } catch {
      // The fixture is still starting.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for the media fixture.\n${serverOutput}`);
}

async function installNaturalPromptAdapter(page: Page): Promise<void> {
  // The deterministic e2e fixture uses terse scenario keys. Keep the visible
  // product interaction natural while routing those prompts to the fixture's
  // already-tested outcomes; no UI, result, or receipt is mocked here.
  await page.route("**/api/chat/stream", async (route) => {
    const request = route.request();
    const parsed = request.postDataJSON() as Record<string, unknown>;
    const visibleMessage = typeof parsed.message === "string" ? parsed.message : "";
    const fixtureMessage = fixtureMessages.get(visibleMessage);
    if (fixtureMessage === undefined) {
      await route.continue();
      return;
    }
    const response = await route.fetch({
      headers: { ...request.headers(), "content-type": "application/json" },
      postData: JSON.stringify({ ...parsed, message: fixtureMessage }),
    });
    const responseBody = (await response.text()).replaceAll(
      '"expiresAt":"2099-01-01T00:05:00.000Z"',
      `"expiresAt":"${FIXED_EXPIRY_ISO}"`,
    );
    await route.fulfill({ response, body: responseBody });
  });
  // The fixture stores its terse routing key. Restore the admin-authored text
  // when history is reloaded so public media demonstrates the real prompt,
  // while the fixture remains compact and deterministic internally.
  await page.route("**/api/chat/history", async (route) => {
    const response = await route.fetch();
    const responseBody = (await response.text()).replaceAll(
      '"role":"user","content":"pdf"',
      `"role":"user","content":${JSON.stringify(prompts.pdf)}`,
    );
    await route.fulfill({ response, body: responseBody });
  });
}

async function openPage(
  browser: Browser,
  query: string,
  options: { recordVideoDir?: string } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: "dark",
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    ...(options.recordVideoDir === undefined
      ? {}
      : { recordVideo: { dir: options.recordVideoDir, size: VIEWPORT } }),
  });
  const fixedNow = Date.parse(FIXED_NOW_ISO);
  await context.addInitScript({
    content: `{
      const NativeDate = Date;
      const fixedNow = ${fixedNow};
      Date = class extends NativeDate {
        constructor(...args) { super(...(args.length === 0 ? [fixedNow] : args)); }
        static now() { return fixedNow; }
      };
    }`,
  });
  const page = await context.newPage();
  await installNaturalPromptAdapter(page);
  await page.goto(`${BASE_URL}/?${query}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "AI Assistant" }).waitFor();
  await page.evaluate(async () => document.fonts.ready);
  return { context, page };
}

async function sendPrompt(page: Page, prompt: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(prompt);
  await composer.press("Enter");
  await page.locator(".message.user").last().getByText(prompt, { exact: true }).waitFor();
}

async function settleVisualState(page: Page): Promise<void> {
  // Playwright clicks leave the pointer over the last control. Move it to a
  // neutral corner so hover-layer compositing cannot perturb otherwise-identical
  // captures by a one-channel anti-aliasing value.
  await page.mouse.move(VIEWPORT.width - 1, VIEWPORT.height - 1);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolveFrame) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()));
    });
  });
}

async function assertConversationCardsInFrame(page: Page): Promise<void> {
  const messages = page.locator(".messages");
  if (await messages.count() === 0) return;
  const clipped = await messages.evaluate((container) => {
    const bounds = container.getBoundingClientRect();
    return [...container.children].flatMap((child) => {
      const rect = child.getBoundingClientRect();
      const intersects = rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
      if (!intersects || (rect.top >= bounds.top - 0.5 && rect.bottom <= bounds.bottom + 0.5)) return [];
      return [{
        label: child.getAttribute("aria-label") ?? child.textContent?.trim().slice(0, 80) ?? child.tagName,
        top: rect.top,
        bottom: rect.bottom,
        frameTop: bounds.top,
        frameBottom: bounds.bottom,
      }];
    });
  });
  if (clipped.length > 0) {
    throw new Error(`conversation_card_outside_capture: ${JSON.stringify(clipped)}`);
  }
}

async function pruneConversationBeforePrompt(page: Page, prompt: string): Promise<void> {
  const currentPrompt = page.locator(".message.user").filter({ hasText: prompt }).last();
  await currentPrompt.evaluate((node) => {
    let previous = node.previousElementSibling;
    while (previous) {
      const remove = previous;
      previous = previous.previousElementSibling;
      remove.remove();
    }
  });
}

async function screenshot(page: Page, filename: typeof screenshotFiles[number]): Promise<void> {
  await settleVisualState(page);
  await assertConversationCardsInFrame(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, filename),
    animations: "disabled",
    caret: "hide",
    scale: "css",
  });
}

async function renderSvgAsset(
  browser: Browser,
  sourcePath: string,
  outputPath: string,
  size: { width: number; height: number },
  transparent: boolean,
): Promise<void> {
  const svg = await readFile(sourcePath);
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    const dataUrl = `data:image/svg+xml;base64,${svg.toString("base64")}`;
    await page.setContent(
      `<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}img{display:block;width:100%;height:100%}</style><img alt="" src="${dataUrl}">`,
      { waitUntil: "load" },
    );
    await page.locator("img").waitFor();
    await page.screenshot({
      path: outputPath,
      animations: "disabled",
      caret: "hide",
      omitBackground: transparent,
      scale: "css",
    });
  } finally {
    await context.close();
  }
}

async function annotateDemoStep(
  page: Page,
  step: number,
  title: string,
  detail: string,
): Promise<void> {
  await page.evaluate(({ currentStep, stepTitle, stepDetail }) => {
    document.querySelector("[data-marketplace-demo-step]")?.remove();
    const note = document.createElement("aside");
    note.dataset.marketplaceDemoStep = String(currentStep);
    note.setAttribute("aria-label", `Demo step ${currentStep} of 7`);
    note.style.cssText = [
      "position:fixed",
      "z-index:9999",
      "right:22px",
      "top:78px",
      "max-width:430px",
      "padding:13px 16px",
      "border:1px solid #5b9bff",
      "border-radius:12px",
      "background:#0e1116f2",
      "box-shadow:0 14px 36px #0008",
      "color:#f7f9fc",
      "font:600 15px/1.35 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    ].join(";");
    const eyebrow = document.createElement("div");
    eyebrow.textContent = `STEP ${currentStep} OF 7 · ${stepTitle}`;
    eyebrow.style.cssText = "color:#79b0ff;font:700 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;margin-bottom:5px";
    const copy = document.createElement("div");
    copy.textContent = stepDetail;
    note.append(eyebrow, copy);
    document.body.appendChild(note);
  }, { currentStep: step, stepTitle: title, stepDetail: detail });
}

async function removeDemoAnnotation(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector("[data-marketplace-demo-step]")?.remove());
}

async function captureStoryFrame(
  page: Page,
  path: string,
  step: number,
  title: string,
  detail: string,
): Promise<void> {
  await annotateDemoStep(page, step, title, detail);
  await settleVisualState(page);
  await assertConversationCardsInFrame(page);
  await page.screenshot({
    path,
    animations: "disabled",
    caret: "hide",
    scale: "css",
  });
}

async function assertAllPermissionGroupsInFrame(page: Page): Promise<void> {
  const controls = page.locator('select[aria-label^="Permission level for "]');
  const controlCount = await controls.count();
  if (controlCount !== FEATURE_GROUPS.length) {
    throw new Error(
      `permission_group_count_mismatch: expected ${FEATURE_GROUPS.length}, received ${controlCount}`,
    );
  }

  const result = await controls.evaluateAll((elements) => {
    const labels = elements.map((element) => element.getAttribute("aria-label"));
    const uniqueLabels = new Set(labels.filter((label): label is string => label !== null));
    const outsideCapture = elements.some((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.top < 0 ||
        rect.left < 0 ||
        rect.bottom > window.innerHeight ||
        rect.right > window.innerWidth
      );
    });
    return { uniqueLabelCount: uniqueLabels.size, outsideCapture };
  });

  if (result.uniqueLabelCount !== FEATURE_GROUPS.length) {
    throw new Error(
      `permission_group_count_mismatch: expected ${FEATURE_GROUPS.length} unique labels, received ${result.uniqueLabelCount}`,
    );
  }
  if (result.outsideCapture) {
    throw new Error("permission_group_outside_capture");
  }
}

async function captureScreenshots(browser: Browser): Promise<void> {
  {
    const { context, page } = await openPage(
      browser,
      "scenario=first-run&theme=dark&language=en",
    );
    await page.getByRole("heading", { name: "Set up your assistant permissions" }).waitFor();
    await page.getByText("DeepSeek processes chat requests for this assistant.").waitFor();
    await page.getByRole("table", { name: "Assistant permissions by feature group" }).waitFor();
    await assertAllPermissionGroupsInFrame(page);
    await screenshot(page, screenshotFiles[0]);
    await context.close();
  }

  {
    const { context, page } = await openPage(browser, "scenario=default&theme=light&language=en");
    await sendPrompt(page, prompts.read);
    await page.getByRole("group", { name: "Done: clockify_reports_summary" }).waitFor();
    await page.getByText("Here is your read-only summary.").waitFor();
    await screenshot(page, screenshotFiles[1]);
    await context.close();
  }

  {
    const { context, page } = await openPage(browser, "scenario=default&theme=dark&language=en");
    await sendPrompt(page, prompts.risky);
    const preview = page.getByRole("group", { name: "Change awaiting confirmation" });
    await preview.getByText("Change the project name to Website launch v2").waitFor();
    await preview.getByRole("button", { name: "Confirm" }).waitFor();
    await screenshot(page, screenshotFiles[2]);
    await context.close();
  }

}

async function captureDemoFrames(browser: Browser, temporaryRoot: string): Promise<StoryFrame[]> {
  const frames: StoryFrame[] = [];
  const frame = (name: string, durationSeconds: number): string => {
    const path = join(temporaryRoot, `${name}.png`);
    frames.push({ path, durationSeconds });
    return path;
  };

  {
    const { context, page } = await openPage(browser, "scenario=first-run&theme=dark&language=en");
    try {
      await page.getByRole("heading", { name: "Set up your assistant permissions" }).waitFor();
      await page.getByText("DeepSeek processes chat requests for this assistant.").waitFor();
      await page.getByRole("link", { name: "Privacy" }).waitFor();
      await captureStoryFrame(
        page,
        frame("01-first-run", 4),
        1,
        "FIRST RUN",
        "DeepSeek disclosure, saved permission controls, and persistent Privacy, Security, and Support links.",
      );
    } finally {
      await context.close();
    }
  }

  {
    const { context, page } = await openPage(browser, "scenario=default&theme=light&language=en");
    try {
      await sendPrompt(page, prompts.read);
      const readReceipt = page.getByRole("group", { name: "Done: clockify_reports_summary" });
      await readReceipt.waitFor();
      await readReceipt.scrollIntoViewIfNeeded();
      await captureStoryFrame(
        page,
        frame("02-read", 4),
        2,
        "READ",
        "A read-only request returns immediately with a complete, sanitized receipt.",
      );

      await sendPrompt(page, prompts.safe);
      const safeReceipt = page.getByRole("group", { name: "Done: clockify_start_timer" });
      await safeReceipt.waitFor();
      await pruneConversationBeforePrompt(page, prompts.safe);
      await safeReceipt.scrollIntoViewIfNeeded();
      await captureStoryFrame(
        page,
        frame("03-safe-write", 4),
        3,
        "SAFE WRITE",
        "The explicitly safe timer action runs immediately and returns an Undo affordance.",
      );

      await sendPrompt(page, prompts.risky);
      const preview = page.getByRole("group", { name: "Change awaiting confirmation" });
      const confirm = preview.getByRole("button", { name: "Confirm" });
      await confirm.waitFor();
      await preview.scrollIntoViewIfNeeded();
      await captureStoryFrame(
        page,
        frame("04-risky-preview", 4),
        4,
        "RISKY PREVIEW",
        "An existing-data edit is held behind its exact preview and the button-only Confirm action.",
      );

      await confirm.click();
      const confirmedReceipt = page.getByRole("group", { name: "Done: clockify_update_project" });
      await confirmedReceipt.waitFor();
      await page.getByText("The risky change was confirmed and completed.").waitFor();
      await confirmedReceipt.scrollIntoViewIfNeeded();
      await captureStoryFrame(
        page,
        frame("05-confirmed", 3),
        5,
        "RECEIPT AND UNDO",
        "The confirmed edit settles truthfully before any later action is shown as complete.",
      );

      await safeReceipt.getByRole("button", { name: "Undo clockify_start_timer" }).click();
      await safeReceipt.getByText("Undone").waitFor();
      await safeReceipt.scrollIntoViewIfNeeded();
      await removeDemoAnnotation(page);
      await screenshot(page, screenshotFiles[3]);
      await captureStoryFrame(
        page,
        frame("05-undo", 3),
        5,
        "RECEIPT AND UNDO",
        "The eligible safe creation is compensated and the receipt changes to the truthful Undone state.",
      );
    } finally {
      await context.close();
    }
  }

  {
    const { context, page } = await openPage(browser, "scenario=history&theme=dark&language=en");
    try {
      await page.getByText("You tracked 6 hours yesterday.").waitFor();
      await sendPrompt(page, prompts.pdf);
      const pdf = page.getByRole("link", {
        name: "Download invoice PDF: clockify-invoice-INV-42.pdf",
      });
      await pdf.waitFor();
      await page.reload({ waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "AI Assistant" }).waitFor();
      const restoredPdf = page.getByRole("link", {
        name: "Download invoice PDF: clockify-invoice-INV-42.pdf",
      });
      await restoredPdf.waitFor();
      const download = page.waitForEvent("download");
      await restoredPdf.click();
      await download;
      await restoredPdf.scrollIntoViewIfNeeded();
      await screenshot(page, screenshotFiles[4]);
      await captureStoryFrame(
        page,
        frame("06-history-pdf", 5),
        6,
        "HISTORY AND PDF",
        "Reload restored the saved conversation and the authenticated PDF download completed.",
      );

      await page.getByRole("button", { name: "Assistant permissions" }).click();
      await page.getByRole("heading", { name: "Assistant permissions" }).waitFor();
      await assertAllPermissionGroupsInFrame(page);
      await captureStoryFrame(
        page,
        frame("07-admin-boundary", 4),
        7,
        "ADMIN BOUNDARY",
        "Owners and administrators control their own policy. Workspace members cannot open the assistant.",
      );
    } finally {
      await context.close();
    }
  }

  return frames;
}

async function encodeStoryVideo(frames: StoryFrame[], outputPath: string, temporaryRoot: string): Promise<void> {
  if (frames.length === 0) throw new Error("Cannot encode an empty marketplace demo.");
  const concatPath = join(temporaryRoot, "demo-frames.txt");
  const concat = frames.flatMap(({ path, durationSeconds }) => [
    `file '${path.replaceAll("'", "'\\''")}'`,
    `duration ${durationSeconds}`,
  ]);
  concat.push(`file '${frames.at(-1)!.path.replaceAll("'", "'\\''")}'`);
  await writeFile(concatPath, `${concat.join("\n")}\n`, "utf8");
  await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatPath,
    "-an",
    "-vf", "fps=30,scale=1440:900:flags=lanczos,format=yuv420p",
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", "20",
    "-threads", "1",
    "-fflags", "+bitexact",
    "-flags:v", "+bitexact",
    "-movflags", "+faststart",
    "-map_metadata", "-1",
    outputPath,
  ]);
}

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.subarray(1, 4).toString("ascii") !== "PNG") {
    throw new Error("Expected a PNG delivery asset.");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function evidenceForPng(path: string): Promise<MediaEvidence> {
  const data = await readFile(path);
  return {
    file: path.replace(`${process.cwd()}/`, ""),
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    ...pngDimensions(data),
  };
}

async function evidenceForVideo(path: string): Promise<MediaEvidence> {
  const data = await readFile(path);
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json",
    path,
  ]);
  const probe = JSON.parse(stdout) as {
    streams?: Array<{ width?: number; height?: number }>;
    format?: { duration?: string };
  };
  const stream = probe.streams?.[0];
  const durationSeconds = Number(probe.format?.duration);
  if (stream?.width === undefined || stream.height === undefined || !Number.isFinite(durationSeconds)) {
    throw new Error("ffprobe did not return complete video metadata.");
  }
  return {
    file: path.replace(`${process.cwd()}/`, ""),
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    width: stream.width,
    height: stream.height,
    durationSeconds,
  };
}

async function backupDeliveryAssets(
  assetPaths: string[],
  temporaryRoot: string,
): Promise<Map<string, string>> {
  const backups = new Map<string, string>();
  const backupRoot = join(temporaryRoot, "prior-delivery-assets");
  await mkdir(backupRoot, { recursive: true });
  for (const [index, assetPath] of assetPaths.entries()) {
    const backupPath = join(backupRoot, `${index}${extname(assetPath)}`);
    try {
      await copyFile(assetPath, backupPath);
      backups.set(assetPath, backupPath);
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return backups;
}

async function priorCaptureSourceSha256(): Promise<string | undefined> {
  try {
    const prior = JSON.parse(await readFile(EVIDENCE_PATH, "utf8")) as {
      captureSourceSha256?: unknown;
    };
    return typeof prior.captureSourceSha256 === "string" ? prior.captureSourceSha256 : undefined;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function pngsAreEquivalent(priorPath: string, generatedPath: string): Promise<boolean> {
  const { stderr } = await execFileAsync("ffmpeg", [
    "-hide_banner", "-nostats", "-loglevel", "info",
    "-i", priorPath,
    "-i", generatedPath,
    "-filter_complex", "blend=all_mode=difference,signalstats,metadata=print",
    "-f", "null", "-",
  ]);
  const maxima = [...stderr.matchAll(/lavfi\.signalstats\.[YUV]MAX=([0-9.]+)/g)]
    .map((match) => Number(match[1]));
  return maxima.length === 3 && maxima.every((maximum) => Number.isFinite(maximum) && maximum <= 1);
}

async function videosAreEquivalent(priorPath: string, generatedPath: string): Promise<boolean> {
  const [prior, generated] = await Promise.all([
    evidenceForVideo(priorPath),
    evidenceForVideo(generatedPath),
  ]);
  if (
    prior.width !== generated.width
    || prior.height !== generated.height
    || prior.durationSeconds === undefined
    || generated.durationSeconds === undefined
    || Math.abs(prior.durationSeconds - generated.durationSeconds) > 0.001
  ) return false;
  const { stderr } = await execFileAsync("ffmpeg", [
    "-hide_banner", "-nostats", "-loglevel", "info",
    "-i", priorPath,
    "-i", generatedPath,
    "-lavfi", "[0:v][1:v]ssim;[0:v][1:v]psnr",
    "-f", "null", "-",
  ]);
  const ssim = Number(/SSIM[^\n]*All:([0-9.]+)/.exec(stderr)?.[1]);
  const psnr = Number(/PSNR[^\n]*average:([0-9.]+)/.exec(stderr)?.[1]);
  return Number.isFinite(ssim) && ssim >= 0.99998 && Number.isFinite(psnr) && psnr >= 65;
}

async function retainEquivalentCanonicalAssets(
  backups: Map<string, string>,
): Promise<string[]> {
  const retained: string[] = [];
  for (const [generatedPath, priorPath] of backups) {
    const [prior, generated] = await Promise.all([readFile(priorPath), readFile(generatedPath)]);
    if (prior.equals(generated)) continue;
    const equivalent = extname(generatedPath) === ".png"
      ? await pngsAreEquivalent(priorPath, generatedPath)
      : extname(generatedPath) === ".mp4"
        ? await videosAreEquivalent(priorPath, generatedPath)
        : false;
    if (!equivalent) continue;
    await copyFile(priorPath, generatedPath);
    retained.push(generatedPath.replace(`${process.cwd()}/`, ""));
  }
  return retained;
}

async function verifyMedia(videoPath: string): Promise<MediaEvidence[]> {
  const [iconSvg, bannerSvg, iconPng] = await Promise.all([
    readFile(ICON_SVG_PATH, "utf8"),
    readFile(BANNER_SVG_PATH, "utf8"),
    readFile(ICON_PNG_PATH),
  ]);
  for (const color of ["#0e1116", "#5b9bff", "#3fce8b"]) {
    if (!iconSvg.toLowerCase().includes(color)) {
      throw new Error(`Marketplace icon is missing the ${color} product token.`);
    }
  }
  if (bannerSvg.includes("PRIVATE RELEASE CANDIDATE")) {
    throw new Error("Marketplace banner contains internal release-status language.");
  }
  if (iconPng.length < 26 || (iconPng[25] !== 4 && iconPng[25] !== 6)) {
    throw new Error("Marketplace icon delivery PNG must preserve its intentional alpha channel.");
  }

  const evidence = await Promise.all([
    evidenceForPng(ICON_PNG_PATH),
    evidenceForPng(BANNER_PNG_PATH),
    ...screenshotFiles.map((filename) => evidenceForPng(join(SCREENSHOT_ROOT, filename))),
  ]);
  evidence.push(await evidenceForVideo(videoPath));
  const expectedDimensions = [
    { width: 512, height: 512 },
    { width: 1600, height: 900 },
    ...Array.from({ length: screenshotFiles.length + 1 }, () => VIEWPORT),
  ];
  evidence.forEach((item, index) => {
    const expected = expectedDimensions[index];
    if (expected === undefined || item.width !== expected.width || item.height !== expected.height) {
      throw new Error(
        `${item.file} is ${item.width}x${item.height}; expected ${expected?.width ?? "?"}x${expected?.height ?? "?"}.`,
      );
    }
    if (item.bytes === 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      throw new Error(`${item.file} did not produce complete size/hash evidence.`);
    }
  });
  const video = evidence.at(-1);
  if (video?.durationSeconds === undefined || video.durationSeconds < 28 || video.durationSeconds > 40) {
    throw new Error(`Marketplace demo duration ${video?.durationSeconds ?? "missing"} is outside 28-40 seconds.`);
  }
  return evidence;
}

async function main(): Promise<void> {
  await mkdir(SCREENSHOT_ROOT, { recursive: true });
  await mkdir(VIDEO_ROOT, { recursive: true });
  const videoPath = join(VIDEO_ROOT, "ai-assistant-1.0.0-demo.mp4");
  const deliveryAssetPaths = [
    ICON_PNG_PATH,
    BANNER_PNG_PATH,
    ...screenshotFiles.map((filename) => join(SCREENSHOT_ROOT, filename)),
    videoPath,
  ];
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ai-assistant-marketplace-media-"));
  const [captureSource, priorCaptureSource] = await Promise.all([
    marketplaceCaptureSourceSha256(),
    priorCaptureSourceSha256(),
  ]);
  const priorDeliveryAssets = captureSource === priorCaptureSource
    ? await backupDeliveryAssets(deliveryAssetPaths, temporaryRoot)
    : new Map<string, string>();
  await Promise.all([
    ...deliveryAssetPaths.map((assetPath) => removeIfPresent(assetPath)),
    removeIfPresent(EVIDENCE_PATH),
    removeIfPresent(VISUAL_REVIEW_PATH),
  ]);

  const server = spawn(process.execPath, ["tests/e2e/fixtures/server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, E2E_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser: Browser | undefined;
  try {
    await waitForFixture(server);
    browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-font-subpixel-positioning",
        "--disable-gpu",
        "--disable-lcd-text",
        "--font-render-hinting=none",
        "--force-device-scale-factor=1",
      ],
    });
    await renderSvgAsset(
      browser,
      ICON_SVG_PATH,
      ICON_PNG_PATH,
      { width: 512, height: 512 },
      true,
    );
    await renderSvgAsset(
      browser,
      BANNER_SVG_PATH,
      BANNER_PNG_PATH,
      { width: 1600, height: 900 },
      false,
    );
    await captureScreenshots(browser);
    const frames = await captureDemoFrames(browser, temporaryRoot);
    await encodeStoryVideo(frames, videoPath, temporaryRoot);
    const canonicalizedEquivalentCaptures = await retainEquivalentCanonicalAssets(
      priorDeliveryAssets,
    );
    const assets = await verifyMedia(videoPath);
    const visualReview: MediaEngineeringReview = {
      schemaVersion: 1,
      status: "pending",
      captureSourceSha256: captureSource,
      assetSetSha256: marketplaceAssetSetSha256(assets),
      reviewer: null,
      reviewedAt: null,
      checks: visualReviewChecks.map((id) => ({ id, status: "pending", notes: null })),
      instructions: "Inspect every generated asset at original size. Set status/checks to passed and record reviewer/reviewedAt only when this exact capture source and asset set passed final engineering inspection. A post-commit workflow artifact binds the checked-in review and evidence to the tested source-candidate SHA and archive hash, and records the evidence commit separately.",
    };
    await writeFile(VISUAL_REVIEW_PATH, `${JSON.stringify(visualReview, null, 2)}\n`, "utf8");
    const evidence: MarketplaceMediaEvidence = {
      schemaVersion: 2,
      source: "deterministic synthetic release-build fixture",
      liveConnectivityEvidence: false,
      containsSecrets: false,
      captureSourceSha256: captureSource,
      visualReview: {
        artifact: "docs/marketplace/assets/media-engineering-review.json",
        requiredStatus: "passed",
      },
      reproducibility: {
        fixedClock: FIXED_NOW_ISO,
        pngCanonicalization: "retain prior bytes only when every YUV pixel delta is at most 1",
        videoCanonicalization: "retain prior bytes only when dimensions and duration match, SSIM >= 0.99998, and PSNR >= 65 dB",
      },
      demoSteps,
      assets,
    };
    await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      evidence: EVIDENCE_PATH,
      canonicalizedEquivalentCaptures,
      ...evidence,
    }, null, 2)}\n`);
  } finally {
    await browser?.close();
    if (server.exitCode === null) server.kill("SIGTERM");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
