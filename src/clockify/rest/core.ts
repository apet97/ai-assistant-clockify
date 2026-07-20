/**
 * Multi-host Clockify REST core. Owns ALL I/O for the REST adapter — host
 * routing, the auth header, and the four request shapes the area modules build
 * on (`call`, `paginate`, `getThenPut`, `postForm`). It holds NO risk decisions,
 * NO policy checks, and NO confirmation logic; those stay in `src/harness/*`.
 *
 * Clockify splits its surface across three hosts that share one tenant:
 *   - api      → https://api.clockify.me/api/v1            (entities, time, billing)
 *   - reports  → https://reports.api.clockify.me/v1        (reports)
 *   - audit    → https://auditlog-api.api.clockify.me/v1   (audit log / change tracking)
 * The reports host is taken from the token `reportsUrl` claim (falling back to a
 * derived prod subdomain). The audit host has NO token claim and exists ONLY on
 * the `auditlog-api.api.<tenant>` subdomain of `api.<tenant>` (prod / regional)
 * hosts; on dev/path hosts there is none, so it is left undefined and a call to
 * the audit host returns a clean "not available" error rather than fetching a
 * host that does not resolve (never hardcode the tenant — see CLAUDE.md). The
 * token/key is sent only in the request header — never logged, never placed in a
 * prompt, never returned.
 */
import type { ClockifyAuth, ListResult } from "../types.js";
import { canonicalClockifyServiceUrl } from "../service-url.js";
import {
  AmbiguousWriteOutcome,
  DefinitiveWriteFailure,
  isMutationMethod,
} from "../write-outcome.js";
import {
  HostCallBudgetExceededError,
  HostRequestCancelledError,
  HOST_CALL_BUDGET_MAXIMUM,
  chargeHostCallBudget,
  withReservedHostCallBudget,
  type WorkspaceRequestGovernor,
} from "../request-governor.js";
import { AsyncLocalStorage } from "node:async_hooks";
export type { ClockifyAuth };
export type ClockifyHost = "api" | "reports" | "audit";

export interface RestCoreOptions {
  /** Verified backend base, e.g. https://api.clockify.me/api/v1 */
  apiBase: string;
  /** Explicit reports host base from the token `reportsUrl` claim (+ /v1). The
   *  reports host is NOT derivable from the api host across environments, so when
   *  present this overrides the derived value. */
  reportsBase?: string;
  /** Explicit audit host base, when known. */
  auditBase?: string;
  auth: ClockifyAuth;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /**
   * Per-request commit/IO timeout (ms). Bounds commit latency (the POST +
   * GET-then-PUT + per-item POSTs of e.g. createInvoice are otherwise unbounded
   * — there is no other wire timeout on this path) so the idempotency-claim TTL
   * is provably above worst-case (r1-concurrency-races-01). Defaults to
   * {@link COMMIT_TIMEOUT_MS}.
   */
  commitTimeoutMs?: number;
  /** Shared per-workspace host-call governor. */
  requestGovernor?: WorkspaceRequestGovernor;
  /** Cancels requests only until they cross the external dispatch boundary. */
  signal?: AbortSignal;
  /** Production adapters enable the Phase 6 exact-plan network gate. */
  enforceMutationScope?: boolean;
}

export interface MutationPlanScopeStep {
  id: string;
  kind: "primary" | "compensation";
}

export interface MutationPlanScopeInput {
  actionName: string;
  plan: { mode: "single" | "curated" | "batch"; maxHostCalls: number; steps: MutationPlanScopeStep[] };
  authorizeDispatch?(step: MutationPlanScopeStep): Promise<unknown> | unknown;
  /** Durable journal hook after authorization and immediately before fetch. */
  onDispatch?(step: MutationPlanScopeStep): void;
  compensationEligible?(stepId: string): boolean;
  /** Durable read-only reconciliation may terminalize an ambiguous primary
   * after its dispatch threw. The caller must prove this exact plan step is now
   * authoritatively settled; dispatch denials and plan violations remain final. */
  authoritativelyReconciled?(stepId: string): boolean;
  /** Caller-owned result policy. REST core intentionally knows nothing about
   * harness receipts; it only enforces complete primary dispatch when asked. */
  requiresComplete?(result: unknown): boolean;
}

type MutationDescriptorStatus = "pending" | "dispatching" | "completed" | "failed";

interface MutationDescriptorState {
  step: MutationPlanScopeStep;
  status: MutationDescriptorStatus;
  authorized: boolean;
  networkCalls: number;
  failure?: unknown;
}

interface MutationPlanScopeState extends MutationPlanScopeInput {
  descriptors: MutationDescriptorState[];
  active?: { index: number; descriptor: MutationDescriptorState };
  primaryPoison?: MutationPlanViolation;
}

function readDescriptorFailure(descriptor: MutationDescriptorState): { failed: boolean; failure?: unknown } {
  return descriptor.status === "failed"
    ? { failed: true, failure: descriptor.failure }
    : { failed: false };
}

const mutationPlanStorage = new AsyncLocalStorage<MutationPlanScopeState>();

/** Mutation reservations must have deterministic physical I/O cost. A list
 * scan inside a prepared operation is therefore one page only; a full page is
 * returned as `truncated` so the harness fails closed before relying on it. */
export function mutationReadPageLimit(): number {
  return mutationPlanStorage.getStore() ? 1 : MAX_PAGES;
}

export class MutationPlanViolation extends Error {
  readonly code = "mutation_plan_violation";
  constructor(message: string) {
    super(message);
    this.name = "MutationPlanViolation";
  }
}

export class MutationDispatchDenied extends Error {
  constructor(readonly denial: unknown) {
    super("mutation_dispatch_denied");
    this.name = "MutationDispatchDenied";
  }
}

/** Typed, non-secret classification for a bounded binary GET that was cancelled
 * before its body could enter an artifact, receipt, prompt, or audit record. */
export class BinaryResponseTooLargeError extends Error {
  readonly code = "artifact_too_large";

  constructor(readonly path: string, readonly maxBytes: number) {
    super(`Clockify GET ${path} exceeded the ${maxBytes}-byte binary limit.`);
    this.name = "BinaryResponseTooLargeError";
  }
}

function reconciledAmbiguousDescriptor(
  scope: MutationPlanScopeState,
  descriptor: MutationDescriptorState,
): boolean {
  if (descriptor.status !== "failed" ||
    descriptor.failure instanceof MutationPlanViolation ||
    descriptor.failure instanceof MutationDispatchDenied ||
    descriptor.failure instanceof DefinitiveWriteFailure) return false;
  try {
    return scope.authoritativelyReconciled?.(descriptor.step.id) === true;
  } catch {
    return false;
  }
}

export function withMutationPlanScope<T>(input: MutationPlanScopeInput, run: () => Promise<T>): Promise<T> {
  const maxHostCalls = input.plan.maxHostCalls;
  if (!Number.isSafeInteger(maxHostCalls) ||
    maxHostCalls < 1 ||
    maxHostCalls > HOST_CALL_BUDGET_MAXIMUM) {
    return Promise.reject(new MutationPlanViolation("mutation_plan_host_call_budget_required"));
  }
  const ids = input.plan.steps.map((step) => step.id);
  if (ids.length === 0 || ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    return Promise.reject(new MutationPlanViolation("invalid_mutation_plan_scope"));
  }
  const scope: MutationPlanScopeState = {
    ...input,
    descriptors: input.plan.steps.map((step) => ({ step, status: "pending", authorized: false, networkCalls: 0 })),
  };
  const execute = () => mutationPlanStorage.run(scope, async () => {
    const result = await run();
    if (input.requiresComplete?.(result)) {
      const incomplete = scope.descriptors.find((descriptor) =>
        descriptor.step.kind === "primary" && descriptor.status !== "completed" &&
        !reconciledAmbiguousDescriptor(scope, descriptor));
      if (incomplete) throw new MutationPlanViolation(`mutation_plan_incomplete:${incomplete.step.id}`);
    }
    return result;
  });
  try {
    return withReservedHostCallBudget(maxHostCalls, execute);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Bind one durable workflow dispatch to its exact persisted plan descriptor. */
export async function withMutationPlanStep<T>(
  input: { id: string; index: number; kind: "primary" | "compensation" },
  run: () => Promise<T>,
): Promise<T> {
  const scope = mutationPlanStorage.getStore();
  // Isolated harness/fake tests perform no network I/O. Production RestCore
  // remains fail-closed when enforceMutationScope is enabled.
  if (!scope) return run();
  if (input.kind === "primary" && scope.primaryPoison) {
    throw new MutationPlanViolation(`mutation_scope_poisoned:${scope.primaryPoison.message}`);
  }
  const descriptor = scope.descriptors[input.index];
  if (!descriptor || descriptor.step.id !== input.id || descriptor.step.kind !== input.kind) {
    const violation = new MutationPlanViolation(`mutation_step_out_of_order:${input.id}`);
    if (input.kind === "primary") scope.primaryPoison = violation;
    throw violation;
  }
  if (scope.active || descriptor.status !== "pending") {
    const violation = new MutationPlanViolation(`mutation_step_repeated:${input.id}`);
    if (input.kind === "primary") scope.primaryPoison = violation;
    throw violation;
  }
  const earlierPrimaryStates = scope.descriptors.slice(0, input.index)
    .filter((candidate) => candidate.step.kind === "primary");
  const earlierPrimaryInvalid = input.kind === "primary"
    ? earlierPrimaryStates.some((candidate) => candidate.status !== "completed")
    : earlierPrimaryStates.some((candidate) => candidate.status === "pending" || candidate.status === "dispatching");
  if (earlierPrimaryInvalid) {
    const violation = new MutationPlanViolation(`mutation_step_out_of_order:${input.id}`);
    if (input.kind === "primary") scope.primaryPoison = violation;
    throw violation;
  }
  if (input.kind === "compensation" && !scope.compensationEligible?.(input.id)) {
    throw new MutationPlanViolation(`compensation_not_eligible:${input.id}`);
  }
  scope.active = { index: input.index, descriptor };
  try {
    const result = await run();
    const afterRun = readDescriptorFailure(descriptor);
    if (afterRun.failed) throw afterRun.failure;
    if (descriptor.networkCalls !== 1) {
      const violation = new MutationPlanViolation(`mutation_step_incomplete_dispatch:${input.id}`);
      descriptor.status = "failed";
      descriptor.failure = violation;
      throw violation;
    }
    descriptor.status = "completed";
    return result;
  } catch (error) {
    descriptor.status = "failed";
    descriptor.failure ??= error;
    if (input.kind === "primary") {
      scope.primaryPoison = error instanceof MutationPlanViolation
        ? error
        : new MutationPlanViolation(`mutation_primary_failed:${input.id}`);
    }
    throw error;
  } finally {
    scope.active = undefined;
  }
}

async function authorizeScopedMutationDispatch(signal?: AbortSignal): Promise<void> {
  const scope = mutationPlanStorage.getStore();
  if (!scope?.active) throw new MutationPlanViolation("mutation_scope_required");
  const { descriptor } = scope.active;
  if (descriptor.status !== "pending" || descriptor.authorized || descriptor.networkCalls > 0) {
    const violation = new MutationPlanViolation(`mutation_step_excess_dispatch:${descriptor.step.id}`);
    descriptor.status = "failed";
    descriptor.failure = violation;
    if (descriptor.step.kind === "primary") scope.primaryPoison = violation;
    throw violation;
  }
  const denial = await scope.authorizeDispatch?.(descriptor.step);
  if (denial !== undefined) {
    const error = new MutationDispatchDenied(denial);
    descriptor.status = "failed";
    descriptor.failure = error;
    if (descriptor.step.kind === "primary") {
      scope.primaryPoison = new MutationPlanViolation(`mutation_primary_denied:${descriptor.step.id}`);
    }
    throw error;
  }
  if (signal?.aborted) throw new HostRequestCancelledError();
  descriptor.authorized = true;
}

function commitScopedMutationDispatch(signal?: AbortSignal): void {
  const scope = mutationPlanStorage.getStore();
  if (!scope?.active) throw new MutationPlanViolation("mutation_scope_required");
  const { descriptor } = scope.active;
  if (descriptor.status !== "pending" || !descriptor.authorized || descriptor.networkCalls > 0) {
    const violation = new MutationPlanViolation(`mutation_step_excess_dispatch:${descriptor.step.id}`);
    descriptor.status = "failed";
    descriptor.failure = violation;
    if (descriptor.step.kind === "primary") scope.primaryPoison = violation;
    throw violation;
  }
  if (signal?.aborted) throw new HostRequestCancelledError();
  try {
    scope.onDispatch?.(descriptor.step);
  } catch {
    const error = new MutationDispatchDenied({ code: "dispatch_journal_unavailable" });
    descriptor.status = "failed";
    descriptor.failure = error;
    if (descriptor.step.kind === "primary") {
      scope.primaryPoison = new MutationPlanViolation(`mutation_primary_denied:${descriptor.step.id}`);
    }
    throw error;
  }
  // The descriptor advances only after the fresh role gate succeeds, directly
  // before the fetch call begins. A swallowed denial therefore cannot unlock a
  // later descriptor.
  descriptor.status = "dispatching";
  descriptor.authorized = false;
  descriptor.networkCalls += 1;
}

/** Deterministic WorkspaceClient test doubles have no HTTP adapter in which to
 * cross the physical dispatch boundary. Their shared helper calls this seam
 * immediately before applying an in-memory mutation; production callers must
 * use RestCore.mutate instead. */
export async function beginScopedMutationDispatchForTest(signal?: AbortSignal): Promise<void> {
  if (!mutationPlanStorage.getStore()) return;
  await authorizeScopedMutationDispatch(signal);
  commitScopedMutationDispatch(signal);
}

export interface RestCore {
  call(
    host: ClockifyHost,
    method: string,
    path: string,
    body?: unknown,
    allow404?: boolean,
  ): Promise<unknown>;
  /** Dispatch a read-only Clockify search whose wire contract requires POST. */
  postQuery(host: ClockifyHost, path: string, body?: unknown): Promise<unknown>;
  /** Dispatch exactly one external mutation. Composite compatibility wrappers
   *  must be split into workflow steps before using this primitive. */
  mutate(
    host: ClockifyHost,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown>;
  paginate(
    host: ClockifyHost,
    path: string,
    params?: Record<string, string>,
  ): Promise<ListResult<unknown>>;
  /** Paginate a list whose page body is an ENVELOPE (`{key:[…]}`) — or a bare array —
   *  unwrapping `envelopeKey` per page (e.g. expense categories: `{categories:[…]}`).
   *  A dotted key walks nested envelopes (e.g. expenses: `"expenses.expenses"` for
   *  `{expenses:{expenses:[…]}}`); a bare array at any level is taken as-is. */
  paginateEnvelope(
    host: ClockifyHost,
    path: string,
    envelopeKey: string,
    params?: Record<string, string>,
  ): Promise<ListResult<unknown>>;
  getThenPut(
    host: ClockifyHost,
    path: string,
    patch: Record<string, unknown>,
  ): Promise<unknown>;
  postForm(
    host: ClockifyHost,
    path: string,
    fields: Record<string, string | Blob>,
  ): Promise<unknown>;
  /** GET a binary body (e.g. an invoice/report export) as raw bytes + content type. */
  getBinary(host: ClockifyHost, path: string, maxBytes?: number): Promise<{ contentType: string; bytes: Uint8Array }>;
}

/** Page size used by `paginate`; Clockify's per-page cap for list endpoints. */
export const PAGE_SIZE = 200;
/** Hard ceiling on pagination loops (200 * 50 = 10k rows) — a runaway backstop. */
export const MAX_PAGES = 50;
/**
 * Default per-request commit/IO timeout (ms). Mirrors LLM_TIMEOUT_MS but is a
 * DISTINCT knob (it bounds the Clockify wire, not the model). The operator
 * override is validated in src/config.ts (COMMIT_TIMEOUT_MS, bounded strictly
 * below CLAIM_TTL_MS) and threaded in as opts.commitTimeoutMs — never read
 * process.env here. Bounds commit latency so the idempotency CLAIM_TTL (5 min)
 * is provably above worst-case (r1-concurrency-races-01). Kept as an exported
 * const because tests/unit/idempotency-store.test.ts imports it for the
 * CLAIM_TTL_MS > COMMIT_TIMEOUT_MS invariant.
 */
export const COMMIT_TIMEOUT_MS = 120_000;

/**
 * Transient HTTP statuses worth a bounded retry on an IDEMPOTENT read. A
 * transient 429/5xx on a GET otherwise surfaces straight to the admin even
 * though a moment's wait would have succeeded. Writes are NEVER retried (not
 * safe to replay), and a thrown timeout/transport error is NEVER retried (so
 * total latency stays bounded) — only a RETURNED retryable status on a GET.
 */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_GET_RETRIES = 2;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Backoff for a retryable GET: honor a sane `Retry-After` (capped 5s), else 300ms→600ms. */
function retryDelayMs(res: Response, attempt: number): number {
  const ra = res.headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 5_000);
  }
  return Math.min(300 * 2 ** attempt, 2_000); // 300ms, 600ms
}

function hostsFor(apiBase: string): { api: string; reports: string; audit: string | undefined } {
  // https://api.clockify.me/api/v1 -> reports.api.clockify.me/v1, auditlog-api.api.clockify.me/v1
  const trustedApiBase = canonicalClockifyServiceUrl(apiBase, "api");
  const u = new URL(trustedApiBase);
  const root = u.host.replace(/^api\./, ""); // clockify.me
  // The audit subdomain only exists where the API host is itself an api.<tenant>
  // subdomain (prod / regional). Dev/path hosts (developer.clockify.me/api) have
  // no audit host — leave it undefined (mirrors resolveClockifyAuditBase).
  const audit = u.host.startsWith("api.") ? `${u.protocol}//auditlog-api.api.${root}/v1` : undefined;
  return {
    api: trustedApiBase,
    reports: `${u.protocol}//reports.api.${root}/v1`,
    audit,
  };
}

export function createRestCore(opts: RestCoreOptions): RestCore {
  const derived = hostsFor(opts.apiBase);
  // The reports/audit hosts vary by environment (prod subdomain vs dev path), so
  // an explicit base (reports from the token claim; audit from
  // resolveClockifyAuditBase) wins over the derived value. `audit` may be
  // undefined when the environment publishes no audit host.
  const hosts: Record<ClockifyHost, string | undefined> = {
    api: derived.api,
    reports: opts.reportsBase
      ? canonicalClockifyServiceUrl(opts.reportsBase, "reports")
      : canonicalClockifyServiceUrl(derived.reports, "reports"),
    audit: opts.auditBase ? canonicalClockifyServiceUrl(opts.auditBase, "audit") : derived.audit,
  };
  const baseFetch = opts.fetchImpl ?? fetch;
  const commitTimeoutMs = opts.commitTimeoutMs ?? COMMIT_TIMEOUT_MS;
  // Bound every Clockify request: a hung host aborts with a clean "timed out"
  // error instead of running past the idempotency claim TTL (a slow commit's
  // live claim must never be swept — r1-concurrency-races-01). AbortSignal.timeout
  // fires a TimeoutError; remap it so the receipt names the host, not a DOMException.
  // A transport-level rejection (ECONNRESET, DNS failure, socket hangup) is named
  // the same way every other core failure is — `Clockify ${method} ${path} failed:
  // <reason>` — so the receipt/model/admin can tell WHICH call broke instead of a
  // context-free "fetch failed" (r1-error-handling-03). Only method/path are added;
  // no secrets (the url/header are never put in the message).
  async function doFetch(
    operation: "read" | "mutation",
    method: string,
    path: string,
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const mutation = operation === "mutation";
    try {
      const externalOperation = async () => {
        if (mutation && opts.enforceMutationScope) commitScopedMutationDispatch(opts.signal);
        const timeoutSignal = AbortSignal.timeout(commitTimeoutMs);
        const signal = !mutation && opts.signal
          ? AbortSignal.any([opts.signal, timeoutSignal])
          : timeoutSignal;
        return baseFetch(url, {
          ...init,
          ...("addonToken" in opts.auth ? { redirect: "error" as const } : {}),
          signal,
        });
      };
      if (opts.requestGovernor) {
        return await opts.requestGovernor.run(
          mutation ? "mutation" : "read",
          externalOperation,
          {
            ...(opts.signal ? { signal: opts.signal } : {}),
            ...(mutation && opts.enforceMutationScope
              ? { onDispatch: () => authorizeScopedMutationDispatch(opts.signal) }
              : {}),
          },
        );
      }
      if (opts.signal?.aborted) throw new HostRequestCancelledError();
      chargeHostCallBudget();
      if (mutation && opts.enforceMutationScope) await authorizeScopedMutationDispatch(opts.signal);
      return await externalOperation();
    } catch (error) {
      if (error instanceof MutationPlanViolation || error instanceof MutationDispatchDenied ||
        error instanceof HostCallBudgetExceededError || error instanceof HostRequestCancelledError) throw error;
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        if (!mutation && opts.signal?.aborted) throw new HostRequestCancelledError();
        const message = `Clockify request timed out after ${commitTimeoutMs}ms (${method} ${path}).`;
        if (mutation) throw new AmbiguousWriteOutcome(method, path, message);
        throw new Error(message);
      }
      const reason = error instanceof Error ? error.message : String(error);
      const message = `Clockify ${method} ${path} failed: ${reason}`;
      if (mutation) throw new AmbiguousWriteOutcome(method, path, message);
      throw new Error(message);
    }
  }
  const authHeader: Record<string, string> =
    "addonToken" in opts.auth
      ? { "X-Addon-Token": opts.auth.addonToken }
      : { "X-Api-Key": opts.auth.apiKey };

  // Clockify refuses some endpoint FAMILIES for add-on tokens regardless of
  // manifest scopes — no scope exists to grant them (probed live 2026-06-10:
  // webhooks, custom-field management, account-level GET /workspaces). Name the
  // restriction instead of surfacing a bare 401; API-key auth keeps the raw
  // error so dev scripts see the unmapped truth. Shared by every request shape
  // (call + getBinary) so the honesty mapping covers them identically.
  function mapAddonRestriction(status: number, method: string, path: string, text: string): void {
    if (status === 401 && "X-Addon-Token" in authHeader && text.includes("API is not accessible")) {
      throw new Error(
        `Clockify does not allow add-ons to call ${method} ${path} — this endpoint is outside the add-on token's reach regardless of manifest scopes.`,
      );
    }
  }

  // Resolve a host base, or fail cleanly when this environment has none (only the
  // audit host can be absent). This prevents fetching a guessed, non-resolving
  // host — the raw "fetch failed" the dev environment used to produce.
  function resolveHost(host: ClockifyHost): string {
    const base = hosts[host];
    if (!base) {
      throw new Error(
        host === "audit"
          ? "Audit log is not available in this Clockify environment (no audit host is published for this workspace)."
          : `No ${host} host is configured for this Clockify environment.`,
      );
    }
    return base;
  }

  // GET-only bounded retry shared by call() + getBinary(): a transient 429/5xx on
  // a read is retried up to MAX_GET_RETRIES with a short backoff. Non-GET requests
  // break out on the first response (writes are never replayed); a thrown
  // timeout/transport error from doFetch propagates without retry (latency stays
  // bounded). GETs carry no body, so there is no body-reuse concern across attempts.
  async function fetchWithRetry(
    operation: "read" | "mutation",
    method: string,
    path: string,
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    let res: Response;
    // A prepared mutation has an exact, pre-reserved physical call ceiling.
    // Retrying a GET inside that scope would make the persisted estimator lie
    // and could exhaust the reservation after earlier writes. Ordinary reads
    // retain the existing bounded retry behavior.
    const maxRetries = mutationPlanStorage.getStore() ? 0 : MAX_GET_RETRIES;
    for (let attempt = 0; ; attempt++) {
      res = await doFetch(operation, method, path, url, init);
      if (res.status === 429) opts.requestGovernor?.noteRateLimited(retryDelayMs(res, attempt));
      const willRetry = method === "GET" && RETRYABLE_STATUS.has(res.status) && attempt < maxRetries;
      if (!willRetry) break;
      await res.text().catch(() => undefined); // drain the body before retrying
      await sleep(retryDelayMs(res, attempt));
    }
    return res;
  }

  async function request(
    operation: "read" | "mutation",
    host: ClockifyHost,
    method: string,
    path: string,
    body?: unknown,
    allow404 = false,
  ): Promise<unknown> {
    const baseHost = resolveHost(host);
    // multipart/form-data bodies must NOT carry a JSON content-type — fetch/undici
    // sets the multipart boundary itself when the body is a FormData.
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const res = await fetchWithRetry(operation, method, path, `${baseHost}${path}`, {
      method,
      headers: { ...(isForm ? {} : { "content-type": "application/json" }), ...authHeader },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      const text = await res.text();
      mapAddonRestriction(res.status, method, path, text);
      const message = `Clockify ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`;
      if (operation === "mutation") {
        if (res.status === 408 || res.status >= 500 || res.status < 400) {
          throw new AmbiguousWriteOutcome(method, path, message, res.status);
        }
        throw new DefinitiveWriteFailure(method, path, message, res.status);
      }
      throw new Error(message);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    // A 2xx body that is not JSON means a proxy/tunnel interjected (HTML error
    // page, "Bad gateway") — name the request like every other `call` failure so
    // the receipt/model/admin can tell WHICH call broke, not a context-free
    // SyntaxError.
    try {
      return JSON.parse(text);
    } catch {
      const message = `Clockify ${method} ${path} returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`;
      if (operation === "mutation") {
        throw new AmbiguousWriteOutcome(method, path, message, res.status);
      }
      throw new Error(message);
    }
  }

  async function call(
    host: ClockifyHost,
    method: string,
    path: string,
    body?: unknown,
    allow404 = false,
  ): Promise<unknown> {
    if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
      throw new Error(`RestCore.call requires a safe read method, received ${method}.`);
    }
    return request("read", host, method, path, body, allow404);
  }

  function recognizedPostQuery(host: ClockifyHost, path: string): boolean {
    const workspace = "\\/workspaces\\/[^/?]+";
    const patterns: Partial<Record<ClockifyHost, readonly RegExp[]>> = {
      reports: [new RegExp(`^${workspace}\\/reports\\/(?:summary|detailed|weekly)$`, "u")],
      audit: [new RegExp(`^${workspace}\\/audit-log$`, "u")],
      api: [
        new RegExp(`^${workspace}\\/scheduling\\/assignments\\/projects\\/totals$`, "u"),
        new RegExp(`^${workspace}\\/time-off\\/requests$`, "u"),
        new RegExp(`^${workspace}\\/webhooks\\/[^/?]+\\/logs(?:\\?[^#]*)?$`, "u"),
      ],
    };
    return patterns[host]?.some((pattern) => pattern.test(path)) === true;
  }

  async function postQuery(host: ClockifyHost, path: string, body?: unknown): Promise<unknown> {
    if (!recognizedPostQuery(host, path)) {
      throw new Error(`RestCore.postQuery requires a recognized read-only POST query route (${host} ${path}).`);
    }
    return request("read", host, "POST", path, body);
  }

  // Loop list endpoints up to the MAX_PAGES backstop and report whether the
  // backstop (rather than a natural short page) ended the loop. `truncated: true`
  // means every one of the MAX_PAGES pages came back full, so there is almost
  // certainly more — the caller must surface that the list is incomplete rather
  // than reason over a silently-capped result. Warns once per truncated list so
  // the truncation is operator-visible even for callers that ignore the flag.
  async function paginate(
    host: ClockifyHost,
    path: string,
    params: Record<string, string> = {},
  ): Promise<ListResult<unknown>> {
    const out: unknown[] = [];
    const pageLimit = mutationReadPageLimit();
    for (let page = 1; page <= pageLimit; page++) {
      const qs = new URLSearchParams({
        ...params,
        page: String(page),
        "page-size": String(PAGE_SIZE),
      });
      const sep = path.includes("?") ? "&" : "?";
      const rows = await call(host, "GET", `${path}${sep}${qs.toString()}`);
      if (!Array.isArray(rows)) {
        throw new Error(`Clockify GET ${path} returned an invalid list response; expected a JSON array.`);
      }
      const arr = rows;
      out.push(...arr);
      if (arr.length < PAGE_SIZE) return { rows: out, truncated: false }; // short page = natural end
    }
    // Reached only if all MAX_PAGES pages were full → there is almost certainly more.
    console.warn(
      `Clockify list ${path} hit the ${pageLimit}-page backstop (${out.length} rows); the result is truncated/incomplete.`,
    );
    return { rows: out, truncated: true };
  }

  async function mutate(
    host: ClockifyHost,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    if (!isMutationMethod(method)) {
      throw new Error(`RestCore.mutate requires a mutation method, received ${method}.`);
    }
    return request("mutation", host, method, path, body);
  }

  async function paginateEnvelope(
    host: ClockifyHost,
    path: string,
    envelopeKey: string,
    params: Record<string, string> = {},
  ): Promise<ListResult<unknown>> {
    // A dotted key walks nested envelopes level by level (e.g. expenses:
    // "expenses.expenses" for {expenses:{expenses:[…]}}); at each level a bare
    // array short-circuits (taken as-is). A missing/wrong envelope fails closed:
    // an empty array would falsely prove absence or uniqueness to the harness.
    const keys = envelopeKey.split(".");
    const unwrap = (data: unknown): unknown[] => {
      let cursor: unknown = data;
      for (const key of keys) {
        if (Array.isArray(cursor)) break; // a bare array at this level is the list
        if (typeof cursor !== "object" || cursor === null) {
          throw new Error(
            `Clockify GET ${path} returned an invalid list response; envelope ${envelopeKey} must resolve to a JSON array.`,
          );
        }
        cursor = (cursor as Record<string, unknown>)[key];
      }
      if (!Array.isArray(cursor)) {
        throw new Error(
          `Clockify GET ${path} returned an invalid list response; envelope ${envelopeKey} must resolve to a JSON array.`,
        );
      }
      return cursor;
    };
    const out: unknown[] = [];
    const pageLimit = mutationReadPageLimit();
    for (let page = 1; page <= pageLimit; page++) {
      const qs = new URLSearchParams({ ...params, page: String(page), "page-size": String(PAGE_SIZE) });
      const sep = path.includes("?") ? "&" : "?";
      const data = (await call(host, "GET", `${path}${sep}${qs.toString()}`)) as
        | Record<string, unknown>
        | unknown[]
        | null;
      const arr = unwrap(data);
      out.push(...arr);
      if (arr.length < PAGE_SIZE) return { rows: out, truncated: false }; // short page = natural end
    }
    console.warn(
      `Clockify list ${path} hit the ${pageLimit}-page backstop (${out.length} rows); the result is truncated/incomplete.`,
    );
    return { rows: out, truncated: true };
  }

  async function getThenPut(
    host: ClockifyHost,
    path: string,
    patch: Record<string, unknown>,
  ): Promise<unknown> {
    const current = ((await call(host, "GET", path)) ?? {}) as Record<string, unknown>;
    const merged = { ...current, ...patch };
    return request("mutation", host, "PUT", path, merged);
  }

  async function postForm(
    host: ClockifyHost,
    path: string,
    fields: Record<string, string | Blob>,
  ): Promise<unknown> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    return request("mutation", host, "POST", path, form);
  }

  async function getBinary(
    host: ClockifyHost,
    path: string,
    maxBytes = 1_000_000,
  ): Promise<{ contentType: string; bytes: Uint8Array }> {
    const res = await fetchWithRetry("read", "GET", path, `${resolveHost(host)}${path}`, { method: "GET", headers: { ...authHeader } });
    if (!res.ok) {
      const text = await res.text();
      mapAddonRestriction(res.status, "GET", path, text);
      throw new Error(`Clockify GET ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new BinaryResponseTooLargeError(path, maxBytes);
    }
    let bytes: Uint8Array;
    const reader = res.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new BinaryResponseTooLargeError(path, maxBytes);
        }
        chunks.push(chunk.value);
      }
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } else {
      bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > maxBytes) {
        throw new BinaryResponseTooLargeError(path, maxBytes);
      }
    }
    return { contentType: res.headers.get("content-type") ?? "application/octet-stream", bytes };
  }

  return { call, postQuery, mutate, paginate, paginateEnvelope, getThenPut, postForm, getBinary };
}
