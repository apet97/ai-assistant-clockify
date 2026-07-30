import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import request from "supertest";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { signSessionCookie } from "../../src/auth/sessions.js";
import { buildSessionCookie } from "../../src/routes/deps.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import type {
  ModelClient,
  ModelMessage,
  ToolCompletion,
} from "../../src/assistant/model-client.js";
import type { WorkspaceClient } from "../../src/clockify/client.js";
import {
  createFakeWorkspace,
  FAKE_MUTATION_METHOD_PATTERN,
} from "../../tests/helpers/fake-clockify.js";
import { makeTestConfig } from "../../tests/helpers/config.js";
import { createLiveMutationJournal, type LiveMutationJournal } from "../live-mutation-journal.js";
import {
  buildLiveV2Report,
  LIVE_V2_PREFIX,
  PersistedCleanupRegistry,
  type CleanupRegistryView,
  type LiveResource,
  type LiveResourceKind,
  type LiveV2Report,
} from "./live-v2-contract.js";

/**
 * B3: the ONE preview→confirm chain the sacrificial live driver executes, and
 * the dry-run entry that proves it against the fake host before any live call.
 *
 * The chain is the REAL production composition, composed the same way
 * `tests/helpers/v2-production-composition.ts` composes it: real `createApp`
 * (every router, pipeline, and service — including the real
 * `OperationPreparationService` and `ConfirmationService` created inside
 * `createApp`), a real SQLite store with real migrations and transactions, and
 * real signed-session auth. Exactly two seams are injected at their production
 * injection points: the model client (case-scripted completions) and the
 * Clockify port. Dry-run injects the fake workspace and a fetch guard (any
 * network attempt throws); live mode injects the real REST adapter — the chain
 * code path is byte-identical between the two.
 *
 * Per write case the chain:
 *   1. POSTs the admin message to `/api/chat/messages` (a real v2 assistant
 *      turn: discovery → tool call → durable preview via
 *      OperationPreparationService; the run suspends awaiting confirmation);
 *   2. reads the STORED confirmation control (id + nonce) from
 *      `/api/runs/:runId/events` — the same envelope the UI's Confirm button
 *      uses — and asserts ZERO Clockify mutations happened so far;
 *   3. confirms through POST `/api/confirmations/:id/confirm` with that stored
 *      nonce (the button-equivalent ConfirmationService path — NEVER any
 *      trusted immediate-write bypass), collects the truthful receipt, and
 *      records every created entity in the persisted cleanup registry AS IT IS
 *      CREATED;
 *   4. replays the SAME nonce and requires rejection (one-use proof) — probed
 *      ONLY after a real commit, because a pre-commit denial never burns the
 *      nonce (src/routes/confirmations.ts) and replaying an unburned nonce
 *      could EXECUTE the write. After a denial the probe instead best-effort
 *      CANCELS the still-armed preview and the case fails as `confirm_failed`.
 *      If a replay is ever (incorrectly) accepted, anything it created is still
 *      registered, so even a duplicate write stays cleanable.
 *
 * Cleanup then removes every registered resource in reverse dependency order
 * through the durable single-step journal (`createLiveMutationJournal`), the
 * same legal path `live-sweep` uses — never a bare unscoped port mutation.
 *
 * The report BOTH modes exit on is built by `buildReportFromChainOutcome`, so
 * the per-case verdicts (including `event_order_violation` and a dropped case)
 * are part of the emitted report and its pass/fail status — never test-only
 * evidence.
 */

export const DRY_RUN_WORKSPACE_ID = "ws-live-v2-dry-run";
export const DRY_RUN_ADMIN_USER_ID = "admin-live-v2-dry-run";

export interface ChainWriteCase {
  id: string;
  kind: LiveResourceKind;
  /** MUST carry LIVE_V2_PREFIX — only fixture-owned names may be created. */
  resourceName: string;
  /** The admin-authored chat message that drives the turn. */
  message: string;
  discoveryQuery: string;
  actionName: string;
  arguments: Record<string, unknown>;
}

/** The default sacrificial write cases: one project, one tag. */
export function defaultChainCases(stamp: string): ChainWriteCase[] {
  const projectName = `${LIVE_V2_PREFIX}PROJECT_${stamp}`;
  const tagName = `${LIVE_V2_PREFIX}TAG_${stamp}`;
  return [
    {
      id: "project_create",
      kind: "project",
      resourceName: projectName,
      message: `Create a sacrificial project named ${projectName}`,
      discoveryQuery: "create a project",
      actionName: "clockify_projects_create",
      arguments: { name: projectName },
    },
    {
      id: "tag_create",
      kind: "tag",
      resourceName: tagName,
      message: `Create a sacrificial tag named ${tagName}`,
      discoveryQuery: "create a tag",
      actionName: "clockify_tags_create",
      arguments: { name: tagName },
    },
  ];
}

export interface ChainCaseEvidence {
  id: string;
  actionName: string;
  status: "passed" | "failed";
  failureCode?: string;
  prepared: boolean;
  confirmed: boolean;
  /** Clockify mutations observed between turn start and confirm. MUST be 0. */
  preConfirmMutations: number;
  /** The replay probe RAN — legal only after the commit burned the nonce. */
  nonceReplayProbed: boolean;
  /** The same stored nonce was replayed and REJECTED (one-use proof). */
  nonceReplayRejected: boolean;
  /** Confirmed creations the cleanup registry could not track. MUST be 0. */
  untrackedCreations: number;
  /** Ordered run-event types for the case's run (prepare/confirm ordering evidence). */
  eventTypes: string[];
  createdRefs: LiveResource[];
}

export interface ChainOutcome {
  /** Cases the driver INTENDED to run; a dropped case fails the report. */
  plannedCases: number;
  cases: ChainCaseEvidence[];
  preparedWrites: number;
  confirmedWrites: number;
  preparationMutations: number;
  trustedBypassCalls: 0;
  nonceReplayRejections: number;
  untrackedCreations: number;
  removedIds: string[];
  cleanupFailureCodes: string[];
  /** Confirmation nonces observed during the run — used ONLY for the
   * secret-free report self-check; never persisted, never printed. */
  collectedNonces: string[];
}

/** A ModelClient that dispatches on the LAST admin message, so each chain case
 * owns its own discovery→call→done mini-script regardless of extra provider
 * calls between cases. */
function caseScriptedModel(cases: ChainWriteCase[]): ModelClient {
  const progress = new Map<string, number>();
  const completionFor = (chainCase: ChainWriteCase, step: number): ToolCompletion => {
    if (step === 0) {
      return {
        text: "",
        toolCalls: [{
          id: `discover-${chainCase.id}`,
          name: DISCOVERY_META_TOOL_NAME,
          arguments: { query: chainCase.discoveryQuery },
        }],
      };
    }
    if (step === 1) {
      return {
        text: "",
        toolCalls: [{
          id: `call-${chainCase.id}`,
          name: chainCase.actionName,
          arguments: chainCase.arguments,
        }],
      };
    }
    return { text: "I prepared the requested change; review and confirm it.", toolCalls: [] };
  };
  return {
    complete: async () => "{}",
    completeWithTools: async (messages: ModelMessage[]) => {
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const matched = cases.find((chainCase) => lastUser?.content.includes(chainCase.message));
      if (!matched) return { text: "No scripted case matches this request.", toolCalls: [] };
      const step = progress.get(matched.id) ?? 0;
      progress.set(matched.id, step + 1);
      return completionFor(matched, step);
    },
  };
}

/** Count Clockify PORT mutations through the one shared mutation-method
 * definition (`FAKE_MUTATION_METHOD_PATTERN`), so dry-run and live agree about
 * what counts as a write. */
function withMutationCounter(
  client: WorkspaceClient,
): { client: WorkspaceClient; mutations: () => number } {
  let count = 0;
  const proxied = new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== "string" || typeof value !== "function") return value;
      if (!FAKE_MUTATION_METHOD_PATTERN.test(property)) {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return (...args: unknown[]) => {
        count += 1;
        return (value as (...args: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as WorkspaceClient;
  return { client: proxied, mutations: () => count };
}

interface DriverComposition {
  app: Express;
  store: Store;
  cookie: string;
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  close: () => void;
}

/** The production composition with the two injected seams — a script-usable
 * mirror of `tests/helpers/v2-production-composition.ts` (which is bound to
 * vitest's test context and cannot run outside a test). */
function composeDriverApp(options: {
  clockify: WorkspaceClient;
  model: ModelClient;
  workspaceId: string;
  adminUserId: string;
}): DriverComposition {
  const tempDir = mkdtempSync(join(tmpdir(), "live-v2-full-"));
  const store = createStore(join(tempDir, "driver.sqlite"), {
    encryptionKey: randomBytes(16).toString("hex"),
  });
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const sessionSecret = randomBytes(32).toString("hex");
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: publicKeyPem,
    clockifyAddonKey: "live-v2-full-driver",
    assistantEngine: "v2",
    sessionSecret,
  });
  // The local installation row is driver bookkeeping only: the injected port
  // owns all Clockify auth, so this token never reaches any wire.
  store.saveInstallation({
    workspaceId: options.workspaceId,
    addonId: "live-v2-full-driver",
    addonUserId: "live-v2-full-driver-user",
    addonToken: `local-${randomBytes(12).toString("hex")}`,
  });
  store.upsertAdminPolicy(options.workspaceId, options.adminUserId, defaultAdminPolicy());
  const session = store.createSession({
    workspaceId: options.workspaceId,
    adminUserId: options.adminUserId,
  });
  const cookieValue = signSessionCookie({
    sessionId: session.id,
    workspaceId: options.workspaceId,
    adminUserId: options.adminUserId,
    workspaceRole: "ADMIN",
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  }, sessionSecret);
  const cookie = buildSessionCookie(cookieValue, false).split(";")[0] as string;
  const app = createApp({
    config,
    store,
    parser: createSignatureParser("live-v2-full-driver", publicKeyPem),
    modelClient: options.model,
    clockifyForWorkspace: () => options.clockify,
  });
  return {
    app,
    store,
    cookie,
    sessionId: session.id,
    workspaceId: options.workspaceId,
    adminUserId: options.adminUserId,
    close: (): void => {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

interface RunEventRow {
  event: { eventType: string };
  attachment?: {
    kind?: string;
    envelope?: { confirmation?: { id?: string; nonce?: string } };
  };
}

async function readRunEvents(
  composition: DriverComposition,
  runId: string,
): Promise<RunEventRow[]> {
  const res = await request(composition.app)
    .get(`/api/runs/${runId}/events`)
    .query({ after: 0 })
    .set("Cookie", composition.cookie);
  if (res.status !== 200) return [];
  const body = res.body as { events?: RunEventRow[] };
  return body.events ?? [];
}

function findConfirmationControl(
  events: RunEventRow[],
): { id: string; nonce: string } | undefined {
  for (const row of events) {
    if (row.attachment?.kind !== "pending_confirmation") continue;
    const confirmation = row.attachment.envelope?.confirmation;
    if (typeof confirmation?.id === "string" && typeof confirmation.nonce === "string") {
      return { id: confirmation.id, nonce: confirmation.nonce };
    }
  }
  return undefined;
}

const ENTITY_TYPE_TO_KIND: Partial<Record<string, LiveResourceKind>> = {
  client: "client",
  project: "project",
  task: "task",
  tag: "tag",
};

interface ConfirmReceipt {
  ok?: boolean;
  changed?: { created?: Array<{ type?: string; id?: string; name?: string; projectId?: string }> };
}

interface ConfirmResponseBody {
  ok?: boolean;
  receipt?: ConfirmReceipt;
}

/** Register every created entity from a confirm receipt AS IT IS OBSERVED. */
function registerReceiptCreations(input: {
  receipt: ConfirmReceipt | undefined;
  fallbackName: string;
  registry: { record(resource: LiveResource): void };
  /** The first confirm must create something trackable (else it is untracked);
   * a replay probe registers whatever exists without that requirement. */
  requireCreation: boolean;
}): { createdRefs: LiveResource[]; untracked: number } {
  const created = input.receipt?.changed?.created ?? [];
  const createdRefs: LiveResource[] = [];
  let untracked = 0;
  if (input.requireCreation && created.length === 0) untracked += 1;
  for (const ref of created) {
    const kind = typeof ref.type === "string" ? ENTITY_TYPE_TO_KIND[ref.type] : undefined;
    const name = typeof ref.name === "string" && ref.name.length > 0
      ? ref.name
      : input.fallbackName;
    if (!kind || typeof ref.id !== "string") {
      untracked += 1;
      continue;
    }
    const resource: LiveResource = {
      kind,
      id: ref.id,
      name,
      ...(typeof ref.projectId === "string" ? { parentId: ref.projectId } : {}),
    };
    try {
      input.registry.record(resource);
      createdRefs.push(resource);
    } catch {
      untracked += 1;
    }
  }
  return { createdRefs, untracked };
}

export interface ConfirmProbeOutcome {
  confirmed: boolean;
  /** The replay probe RAN. It may run ONLY after a real commit. */
  nonceReplayProbed: boolean;
  nonceReplayRejected: boolean;
  createdRefs: LiveResource[];
  untrackedCreations: number;
}

/**
 * The button-equivalent confirm plus the one-use replay probe, with the rule
 * that makes the probe safe on a live workspace: the SAME nonce is replayed
 * ONLY after the first confirm actually COMMITTED (which burns it). A
 * pre-commit denial never burns the nonce (src/routes/confirmations.ts), so
 * replaying after a denial could EXECUTE the write; instead the probe
 * best-effort CANCELS the still-armed preview and reports `confirmed: false`.
 * If a replay is ever (incorrectly) accepted, everything it created is still
 * registered, so even a duplicate live write stays cleanable.
 */
export async function confirmPreparedCase(input: {
  control: { id: string; nonce: string };
  chainCase: { resourceName: string };
  registry: { record(resource: LiveResource): void };
  postConfirm: (id: string, nonce: string) => Promise<{ status: number; body: unknown }>;
  cancelPending: (id: string) => Promise<void>;
}): Promise<ConfirmProbeOutcome> {
  const first = await input.postConfirm(input.control.id, input.control.nonce);
  const firstBody = first.body as ConfirmResponseBody;
  const confirmed = first.status === 200 && firstBody.ok === true && firstBody.receipt?.ok === true;

  if (!confirmed) {
    // Never probe an unburned nonce. Disarm the pending preview instead —
    // best-effort: the denial is already the case's failure.
    try {
      await input.cancelPending(input.control.id);
    } catch {
      // Nothing to add: the case fails as confirm_failed either way.
    }
    return {
      confirmed: false,
      nonceReplayProbed: false,
      nonceReplayRejected: false,
      createdRefs: [],
      untrackedCreations: 0,
    };
  }

  // Register every created entity AS IT IS CREATED (before anything else can fail).
  const registered = registerReceiptCreations({
    receipt: firstBody.receipt,
    fallbackName: input.chainCase.resourceName,
    registry: input.registry,
    requireCreation: true,
  });
  const createdRefs = [...registered.createdRefs];
  let untrackedCreations = registered.untracked;

  // One-use proof — legal only now, after the commit burned the nonce.
  const replay = await input.postConfirm(input.control.id, input.control.nonce);
  const replayBody = replay.body as ConfirmResponseBody;
  // Any receipt in the replay's body means a second commit was attempted; only
  // a receipt-free 4xx counts as the rejection the one-use claim promises.
  const replayCommitted = replayBody.receipt !== undefined;
  const nonceReplayRejected = !replayCommitted && replay.status >= 400;
  if (replayCommitted) {
    const duplicate = registerReceiptCreations({
      receipt: replayBody.receipt,
      fallbackName: input.chainCase.resourceName,
      registry: input.registry,
      requireCreation: false,
    });
    createdRefs.push(...duplicate.createdRefs);
    untrackedCreations += duplicate.untracked;
  }
  return {
    confirmed: true,
    nonceReplayProbed: true,
    nonceReplayRejected,
    createdRefs,
    untrackedCreations,
  };
}

function eventOrderHolds(eventTypes: string[]): boolean {
  const at = (type: string): number => eventTypes.indexOf(type);
  return at("operation.prepared") >= 0
    && at("run.suspended") > at("operation.prepared")
    && at("operation.confirmed") > at("run.suspended")
    && at("operation.started") > at("operation.confirmed")
    && at("operation.completed") > at("operation.started");
}

async function runOneCase(input: {
  composition: DriverComposition;
  mutations: () => number;
  chainCase: ChainWriteCase;
  registry: PersistedCleanupRegistry;
  collectedNonces: string[];
}): Promise<ChainCaseEvidence> {
  const { composition, mutations, chainCase, registry, collectedNonces } = input;
  const base: ChainCaseEvidence = {
    id: chainCase.id,
    actionName: chainCase.actionName,
    status: "failed",
    prepared: false,
    confirmed: false,
    preConfirmMutations: 0,
    nonceReplayProbed: false,
    nonceReplayRejected: false,
    untrackedCreations: 0,
    eventTypes: [],
    createdRefs: [],
  };
  const baselineMutations = mutations();

  // 1. The assistant turn: a real v2 run that must SUSPEND on a preview.
  const chatRes = await request(composition.app)
    .post("/api/chat/messages")
    .set("Cookie", composition.cookie)
    .send({ message: chainCase.message });
  if (chatRes.status !== 200) return { ...base, failureCode: "chat_turn_failed" };

  const active = composition.store.getActiveRunForSession(
    composition.sessionId,
    composition.workspaceId,
    composition.adminUserId,
  );
  if (!active) return { ...base, failureCode: "no_suspended_run" };
  const runId = active.runId;

  // 2. The STORED confirmation control — the exact envelope the Confirm button uses.
  const preEvents = await readRunEvents(composition, runId);
  const control = findConfirmationControl(preEvents);
  if (!control) {
    return {
      ...base,
      failureCode: "no_pending_confirmation",
      eventTypes: preEvents.map((row) => row.event.eventType),
    };
  }
  collectedNonces.push(control.nonce);
  const preConfirmMutations = mutations() - baselineMutations;
  const prepared = true;

  // 3+4. Button-equivalent confirm through ConfirmationService, then the
  // one-use replay probe. `confirmPreparedCase` owns the safety rule: the
  // nonce is replayed ONLY after a real commit; a denial cancels the still-
  // armed preview instead of re-posting an unburned nonce.
  const probe = await confirmPreparedCase({
    control,
    chainCase,
    registry,
    postConfirm: async (id, nonce) => {
      const res = await request(composition.app)
        .post(`/api/confirmations/${id}/confirm`)
        .set("Cookie", composition.cookie)
        .send({ nonce });
      return { status: res.status, body: res.body as unknown };
    },
    cancelPending: async (id) => {
      await request(composition.app)
        .post(`/api/confirmations/${id}/cancel`)
        .set("Cookie", composition.cookie)
        .send({});
    },
  });

  const postEvents = await readRunEvents(composition, runId);
  const eventTypes = postEvents.map((row) => row.event.eventType);
  const orderOk = eventOrderHolds(eventTypes);

  const failureCode = !probe.confirmed
    ? "confirm_failed"
    : preConfirmMutations !== 0
      ? "mutation_before_confirm"
      : !probe.nonceReplayRejected
        ? "nonce_reuse_accepted"
        : probe.untrackedCreations > 0
          ? "untracked_creation"
          : !orderOk
            ? "event_order_violation"
            : undefined;

  return {
    ...base,
    status: failureCode === undefined ? "passed" : "failed",
    ...(failureCode !== undefined ? { failureCode } : {}),
    prepared,
    confirmed: probe.confirmed,
    preConfirmMutations,
    nonceReplayProbed: probe.nonceReplayProbed,
    nonceReplayRejected: probe.nonceReplayRejected,
    untrackedCreations: probe.untrackedCreations,
    eventTypes,
    createdRefs: probe.createdRefs,
  };
}

/** Remove one registered fixture through the durable single-step journal —
 * the same legal mutation path `live-sweep` uses (never a bare port call). */
async function removeChainResource(
  journal: LiveMutationJournal,
  client: WorkspaceClient,
  resource: LiveResource,
): Promise<void> {
  switch (resource.kind) {
    case "tag":
      await journal.runSingle(
        "live_v2_cleanup_tag_delete",
        { type: "tag", id: resource.id },
        () => client.deleteTagAtomic(resource.id),
      );
      return;
    case "task": {
      const projectId = resource.parentId;
      if (!projectId) throw new Error("live_v2_cleanup_task_missing_project");
      await journal.runSingle(
        "live_v2_cleanup_task_delete",
        { type: "task", id: resource.id },
        () => client.deleteTaskAtomic(projectId, resource.id),
      );
      return;
    }
    case "project": {
      const body = await client.prepareProjectUpdate(resource.id, { archived: true });
      await journal.runSingle(
        "live_v2_cleanup_project_archive",
        { type: "project", id: resource.id },
        async () => {
          await client.archiveProjectAtomic(resource.id, body);
        },
      );
      await journal.runSingle(
        "live_v2_cleanup_project_delete",
        { type: "project", id: resource.id },
        () => client.deleteProjectAtomic(resource.id),
      );
      return;
    }
    case "client": {
      const body = await client.prepareClientUpdate(resource.id, { archived: true });
      await journal.runSingle(
        "live_v2_cleanup_client_archive",
        { type: "client", id: resource.id },
        async () => {
          await client.updateClientAtomic(resource.id, body);
        },
      );
      await journal.runSingle(
        "live_v2_cleanup_client_delete",
        { type: "client", id: resource.id },
        () => client.deleteClientAtomic(resource.id),
      );
      return;
    }
  }
}

/** Drive the full chain — every case, then cleanup in reverse dependency
 * order — against WHATEVER Clockify port is injected. */
export async function runV2WriteChain(options: {
  clockify: WorkspaceClient;
  registry: PersistedCleanupRegistry;
  workspaceId: string;
  adminUserId: string;
  cases?: ChainWriteCase[];
}): Promise<ChainOutcome> {
  const cases = options.cases ?? defaultChainCases(Date.now().toString(36));
  const counted = withMutationCounter(options.clockify);
  const model = caseScriptedModel(cases);
  const composition = composeDriverApp({
    clockify: counted.client,
    model,
    workspaceId: options.workspaceId,
    adminUserId: options.adminUserId,
  });

  const evidence: ChainCaseEvidence[] = [];
  const collectedNonces: string[] = [];
  const removedIds: string[] = [];
  const cleanupFailureCodes: string[] = [];
  try {
    for (const chainCase of cases) {
      evidence.push(await runOneCase({
        composition,
        mutations: counted.mutations,
        chainCase,
        registry: options.registry,
        collectedNonces,
      }));
    }

    const journal = createLiveMutationJournal(options.workspaceId, options.adminUserId);
    try {
      for (const resource of options.registry.pendingCleanup()) {
        try {
          await removeChainResource(journal, options.clockify, resource);
          options.registry.markRemoved(resource.id);
          removedIds.push(resource.id);
        } catch {
          cleanupFailureCodes.push(`${resource.kind}_cleanup_failed`);
        }
      }
    } finally {
      journal.close();
    }
  } finally {
    composition.close();
  }

  return {
    plannedCases: cases.length,
    cases: evidence,
    preparedWrites: evidence.filter((c) => c.prepared).length,
    confirmedWrites: evidence.filter((c) => c.confirmed).length,
    preparationMutations: evidence.reduce((total, c) => total + c.preConfirmMutations, 0),
    trustedBypassCalls: 0,
    nonceReplayRejections: evidence.filter((c) => c.confirmed && c.nonceReplayRejected).length,
    untrackedCreations: evidence.reduce((total, c) => total + c.untrackedCreations, 0),
    removedIds,
    cleanupFailureCodes,
    collectedNonces,
  };
}

/**
 * The ONE report construction both modes exit on: every per-case verdict (id,
 * action, status, bounded failure code) enters the emitted report alongside
 * the aggregate counters, so a case-level failure or a dropped case makes the
 * run itself go red — never only a test asserting over the outcome.
 */
export function buildReportFromChainOutcome(input: {
  mode: "dry_run" | "live";
  workspaceId: string;
  outcome: ChainOutcome;
  registry: CleanupRegistryView;
}): LiveV2Report {
  return buildLiveV2Report({
    mode: input.mode,
    workspaceId: input.workspaceId,
    plannedWrites: input.outcome.plannedCases,
    cases: input.outcome.cases.map((chainCase) => ({
      id: chainCase.id,
      actionName: chainCase.actionName,
      status: chainCase.status,
      ...(chainCase.failureCode !== undefined ? { failureCode: chainCase.failureCode } : {}),
    })),
    preparedWrites: input.outcome.preparedWrites,
    confirmedWrites: input.outcome.confirmedWrites,
    preparationMutations: input.outcome.preparationMutations,
    trustedBypassCalls: input.outcome.trustedBypassCalls,
    nonceReplayRejections: input.outcome.nonceReplayRejections,
    untrackedCreations: input.outcome.untrackedCreations,
    registry: input.registry,
    removedIds: input.outcome.removedIds,
  });
}

/** Block every real network call for the dry run's lifetime. */
function installFetchGuard(): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const target = typeof input === "string" || input instanceof URL
      ? String(input)
      : ((input as { url?: string } | undefined)?.url ?? "<unknown>");
    throw new Error(`live_v2_dry_run_network_blocked: fetch ${target}`);
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

/** The dry-run entry: the exact chain, fake host, zero network, real report. */
export async function runLiveV2DryRun(options: {
  cleanupRegistryPath: string;
  cases?: ChainWriteCase[];
}): Promise<{ report: LiveV2Report; outcome: ChainOutcome }> {
  const registry = new PersistedCleanupRegistry(options.cleanupRegistryPath);
  const fake = createFakeWorkspace({});
  const restoreFetch = installFetchGuard();
  try {
    const outcome = await runV2WriteChain({
      clockify: fake.client,
      registry,
      workspaceId: DRY_RUN_WORKSPACE_ID,
      adminUserId: DRY_RUN_ADMIN_USER_ID,
      ...(options.cases ? { cases: options.cases } : {}),
    });
    const report = buildReportFromChainOutcome({
      mode: "dry_run",
      workspaceId: DRY_RUN_WORKSPACE_ID,
      outcome,
      registry,
    });
    return { report, outcome };
  } finally {
    restoreFetch();
  }
}
