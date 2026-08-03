import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { signSessionCookie } from "../../src/auth/sessions.js";
import { buildSessionCookie } from "../../src/routes/deps.js";
import type { AppConfig } from "../../src/config.js";
import { defaultAdminPolicy, type AdminPolicy } from "../../src/harness/permissions.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import type { RunEventAttachment } from "../../src/assistant-v2/events.js";
import type { ToolCompletion } from "../../src/assistant/model-client.js";
import {
  createFakeWorkspace,
  FAKE_MUTATION_METHOD_PATTERN,
  type FakeWorkspace,
} from "./fake-clockify.js";
import type { FakeWorkspaceSeed } from "./fake/state.js";
import { makeTestConfig } from "./config.js";
import { testKeys } from "./test-keys.js";
import { scriptedToolModel, type ScriptedToolModel } from "./scripted-model.js";

/**
 * THE one documented way to exercise the real v2 production composition
 * (closure-plan PR 1). Everything on the request path is real: `createApp`,
 * every router and pipeline, a real SQLite store with real migrations and
 * transactions, the production `MODEL_API_ACTION_CATALOG` and API operation
 * index (built by `createApp` itself — never injected), session auth, and the
 * run-event journal. Exactly two seams are substituted, both at their
 * production injection points: the model client (`scriptedToolModel`) and the
 * Clockify port (`createFakeWorkspace`).
 *
 * Guarantees the permissive-fake failure class cannot recur here:
 * - the store is the REAL store — `getRun` etc. return what was persisted, not
 *   a stub's `undefined`;
 * - any attempt to reach the network fails loudly (`globalThis.fetch` is
 *   replaced for the composition's lifetime);
 * - provider calls, Clockify port calls, and Clockify MUTATION calls are
 *   counted separately so a test can assert "zero model calls" or "zero
 *   writes" exactly.
 *
 * Call inside a test (`it`/`test`) — cleanup self-registers via
 * `onTestFinished`, so no per-file `afterEach` bookkeeping is needed.
 */

export const V2_COMPOSITION_NOW = new Date("2026-07-26T00:00:00.000Z");
const ADDON_KEY = "addon-key";

export interface ComposeV2Options {
  /** Scripted native-tool completions, one per provider call (last repeats). */
  script?: ToolCompletion[];
  /** Fake Clockify seed (users, entries, projects, …). */
  seed?: FakeWorkspaceSeed;
  /** Engine under test. Defaults to "v2"; pass "v1" for parity comparisons. */
  engine?: "v1" | "v2";
  /**
   * Back the store with a real temp FILE instead of `:memory:` — required by
   * crash/reopen suites (`reopenStore`). Slightly slower; default off.
   */
  fileBacked?: boolean;
  /** Initial shared app+store clock. Defaults to `V2_COMPOSITION_NOW`. */
  now?: Date;
  /**
   * Admin policy row seeded for the admin (a REAL `admin_policies` row, the
   * existing-admin production path — not the implicit new-admin default).
   * Pass `null` to seed nothing and exercise the fallback path.
   */
  policy?: AdminPolicy | null;
  workspaceId?: string;
  adminUserId?: string;
  /** Extra AppConfig overrides applied after the harness defaults. */
  config?: Partial<AppConfig>;
}

export interface V2Composition {
  app: Express;
  store: Store;
  workspace: FakeWorkspace;
  model: ScriptedToolModel;
  workspaceId: string;
  adminUserId: string;
  sessionId: string;
  cookie: string;
  /** File-backed only: the SQLite path, for raw read-only SQL assertions on
   * tables the Store facade deliberately exposes no reader for. */
  databaseFile?: string;
  /** Advance the ONE shared store+app clock (ages rows exactly like wall time). */
  setClock: (value: Date) => void;
  /** Number of provider (model) completions requested so far. */
  providerCalls: () => number;
  /** The exact messages sent to the provider on a given completion (0-based),
   * for asserting what the model could actually SEE. */
  providerMessages: (call: number) => Array<{ role: string; content: string }>;
  /** Total Clockify PORT calls (reads + writes) the fake observed. */
  clockifyCalls: () => number;
  /** Clockify MUTATION calls only — must stay 0 until a preview is confirmed. */
  clockifyMutations: () => number;
  /** Scope tuple for store reads keyed by (session, run, workspace, admin). */
  runScope: (runId: string) => {
    sessionId: string;
    runId: string;
    workspaceId: string;
    adminUserId: string;
  };
  /** Full `getRun` scope including installation generation + auth class. */
  getRunScope: (runId: string, generation?: number) => {
    sessionId: string;
    runId: string;
    workspaceId: string;
    adminUserId: string;
    installationGeneration: number;
    authClass: "addon";
  };
  /** The session's single active (nonterminal) run id; throws if none. */
  activeRunId: () => string;
  /** The most recently STARTED run id for the primary session, active or
   * terminal — the inspection handle for runs that completed inside one HTTP
   * call. Throws if the session never started a run. */
  latestRunId: () => string;
  /** POST /api/chat/messages with this composition's cookie. */
  chat: (message: string, extra?: Record<string, unknown>) => request.Test;
  /** GET /api/runs/:id/events (after=0) decoded to event rows. */
  readEvents: (runId: string) => Promise<RunEventRow[]>;
  /** Mint a second authenticated session (same or another admin/workspace). */
  mintSession: (opts?: { workspaceId?: string; adminUserId?: string }) => {
    sessionId: string;
    cookie: string;
  };
  /**
   * File-backed only: close the app's store and open a FRESH store on the same
   * database file — the restart-inspection seam for crash/reopen tests. The
   * Express app is unusable afterwards; assert against the returned store.
   */
  reopenStore: () => Store;
  /** Idempotent teardown (also runs automatically at test end). */
  close: () => void;
}

export interface RunEventRow {
  event: { eventType: string; sequence?: number; payload: Record<string, unknown> };
  attachment?: RunEventAttachment;
}

/** Block every real network call for as long as any composition is open. */
let networkGuardDepth = 0;
let realFetch: typeof globalThis.fetch | undefined;

function installNetworkGuard(): void {
  if (networkGuardDepth === 0) {
    realFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown) => {
      const target =
        typeof input === "string" || input instanceof URL
          ? String(input)
          : ((input as { url?: string } | undefined)?.url ?? "<unknown>");
      throw new Error(
        `unmocked network call blocked by v2-production-composition: fetch ${target}`,
      );
    }) as typeof globalThis.fetch;
  }
  networkGuardDepth += 1;
}

function removeNetworkGuard(): void {
  networkGuardDepth -= 1;
  if (networkGuardDepth === 0 && realFetch) {
    globalThis.fetch = realFetch;
    realFetch = undefined;
  }
}

export async function composeV2ProductionApp(
  options: ComposeV2Options = {},
): Promise<V2Composition> {
  const workspaceId = options.workspaceId ?? "ws-1";
  const adminUserId = options.adminUserId ?? "admin-1";
  const keys = await testKeys();
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
    assistantEngine: options.engine ?? "v2",
    ...options.config,
  });

  // ONE clock for the store and the app, as in production. Splitting them makes
  // every row born "expired" relative to the other clock (the T15-E skew class).
  let clock = options.now ?? V2_COMPOSITION_NOW;
  const tempDir = options.fileBacked
    ? mkdtempSync(join(tmpdir(), "v2-composition-"))
    : undefined;
  const databasePath = tempDir ? join(tempDir, "db.sqlite") : ":memory:";
  let store = createStore(databasePath, { encryptionKey: "test-key", now: () => clock });

  store.saveInstallation({
    workspaceId,
    addonId: "addon-1",
    addonUserId: "addon-user-1",
    addonToken: "addon-token",
  });
  const policy = options.policy === null ? undefined : (options.policy ?? defaultAdminPolicy());
  if (policy) store.upsertAdminPolicy(workspaceId, adminUserId, policy);

  const workspace = createFakeWorkspace(options.seed ?? {});
  const model = scriptedToolModel(options.script ?? [{ text: "Done.", toolCalls: [] }]);
  const app = createApp({
    config,
    store,
    parser: createSignatureParser(ADDON_KEY, keys.pem),
    modelClient: model,
    clockifyForWorkspace: () => workspace.client,
    now: () => clock,
  });

  const mintSession = (opts: { workspaceId?: string; adminUserId?: string } = {}) => {
    const ws = opts.workspaceId ?? workspaceId;
    const admin = opts.adminUserId ?? adminUserId;
    const session = store.createSession({ workspaceId: ws, adminUserId: admin });
    // `verifySessionCookie` checks expiry against the REAL wall clock, so the
    // cookie carries a far-future expiry; the store's own `expiresAt` (session
    // bookkeeping under the frozen test clock) is untouched.
    const value = signSessionCookie(
      {
        sessionId: session.id,
        workspaceId: ws,
        adminUserId: admin,
        workspaceRole: "ADMIN",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      config.sessionSecret,
    );
    return { sessionId: session.id, cookie: buildSessionCookie(value, false).split(";")[0]! };
  };

  const primary = mintSession();

  installNetworkGuard();
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    removeNetworkGuard();
    try {
      store.close();
    } finally {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    }
  };
  onTestFinished(close);

  const composition: V2Composition = {
    app,
    get store() {
      return store;
    },
    workspace,
    model,
    workspaceId,
    adminUserId,
    sessionId: primary.sessionId,
    cookie: primary.cookie,
    ...(tempDir ? { databaseFile: databasePath } : {}),
    setClock: (value) => {
      clock = value;
    },
    providerCalls: () => model.calls.length,
    providerMessages: (call) =>
      (model.calls[call]?.messages ?? []).map((m) => ({
        role: String(m.role),
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      })),
    clockifyCalls: () =>
      Object.values(workspace.counts).reduce((total, count) => total + count, 0),
    clockifyMutations: () =>
      Object.entries(workspace.counts)
        .filter(([method]) => FAKE_MUTATION_METHOD_PATTERN.test(method))
        .reduce((total, [, count]) => total + count, 0),
    runScope: (runId) => ({
      sessionId: primary.sessionId,
      runId,
      workspaceId,
      adminUserId,
    }),
    getRunScope: (runId, generation = 1) => ({
      sessionId: primary.sessionId,
      runId,
      workspaceId,
      adminUserId,
      installationGeneration: generation,
      authClass: "addon" as const,
    }),
    activeRunId: () => {
      const active = store.getActiveRunForSession(primary.sessionId, workspaceId, adminUserId);
      if (!active) throw new Error("expected an active run for the primary session");
      return active.runId;
    },
    latestRunId: () => {
      const events = store.listRunEventsForMetrics({
        workspaceId,
        adminUserId,
        since: "1970-01-01T00:00:00.000Z",
        limit: 1000,
      });
      const started = events
        .filter((e) => e.sessionId === primary.sessionId && e.eventType === "run.started")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const latest = started.at(-1);
      if (!latest) throw new Error("expected the primary session to have started a run");
      return latest.runId;
    },
    chat: (message, extra = {}) =>
      request(app)
        .post("/api/chat/messages")
        .set("Cookie", primary.cookie)
        .send({ message, ...extra }),
    readEvents: async (runId) => {
      const res = await request(app)
        .get(`/api/runs/${runId}/events`)
        .query({ after: 0 })
        .set("Cookie", primary.cookie);
      if (res.status !== 200) {
        throw new Error(`GET /api/runs/${runId}/events returned ${res.status}`);
      }
      return (res.body.events ?? res.body.data?.events) as RunEventRow[];
    },
    mintSession,
    reopenStore: () => {
      if (!tempDir) {
        throw new Error("reopenStore requires composeV2ProductionApp({ fileBacked: true })");
      }
      store.close();
      store = createStore(databasePath, { encryptionKey: "test-key", now: () => clock });
      return store;
    },
    close,
  };
  return composition;
}

/**
 * The v2 runner's first completion may only call the discovery meta-tool; the
 * requested tool becomes callable in the NEXT completion. This is the standard
 * three-step read script: discover → call → answer.
 */
export function discoverThenCall(
  query: string,
  call: { name: string; arguments: Record<string, unknown> },
  finalText = "All done.",
): ToolCompletion[] {
  return [
    {
      text: "",
      toolCalls: [{ id: "tc-find", name: DISCOVERY_META_TOOL_NAME, arguments: { query } }],
    },
    { text: "", toolCalls: [{ id: "tc-call", name: call.name, arguments: call.arguments }] },
    { text: finalText, toolCalls: [] },
  ];
}

/** Decode an NDJSON response body into its frames. */
export function ndjsonFrames(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
