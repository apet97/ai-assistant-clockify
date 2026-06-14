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
export type ClockifyAuth = { addonToken: string } | { apiKey: string };
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
}

export interface RestCore {
  call(
    host: ClockifyHost,
    method: string,
    path: string,
    body?: unknown,
    allow404?: boolean,
  ): Promise<unknown>;
  paginate(
    host: ClockifyHost,
    path: string,
    params?: Record<string, string>,
  ): Promise<unknown[]>;
  /** Like {@link paginate}, but reports whether the MAX_PAGES backstop truncated the list. */
  paginateWithMeta(
    host: ClockifyHost,
    path: string,
    params?: Record<string, string>,
  ): Promise<{ rows: unknown[]; truncated: boolean }>;
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
  getBinary(host: ClockifyHost, path: string): Promise<{ contentType: string; bytes: Uint8Array }>;
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
  const u = new URL(apiBase);
  const root = u.host.replace(/^api\./, ""); // clockify.me
  // The audit subdomain only exists where the API host is itself an api.<tenant>
  // subdomain (prod / regional). Dev/path hosts (developer.clockify.me/api) have
  // no audit host — leave it undefined (mirrors resolveClockifyAuditBase).
  const audit = u.host.startsWith("api.") ? `${u.protocol}//auditlog-api.api.${root}/v1` : undefined;
  return {
    api: apiBase.replace(/\/$/, ""),
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
    reports: opts.reportsBase ?? derived.reports,
    audit: opts.auditBase ?? derived.audit,
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
  async function doFetch(method: string, path: string, url: string, init: RequestInit): Promise<Response> {
    try {
      return await baseFetch(url, { ...init, signal: AbortSignal.timeout(commitTimeoutMs) });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Error(`Clockify request timed out after ${commitTimeoutMs}ms (${method} ${path}).`);
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Clockify ${method} ${path} failed: ${reason}`);
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
  async function fetchWithRetry(method: string, path: string, url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await doFetch(method, path, url, init);
      const willRetry = method === "GET" && RETRYABLE_STATUS.has(res.status) && attempt < MAX_GET_RETRIES;
      if (!willRetry) break;
      await res.text().catch(() => undefined); // drain the body before retrying
      await sleep(retryDelayMs(res, attempt));
    }
    return res;
  }

  async function call(
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
    const res = await fetchWithRetry(method, path, `${baseHost}${path}`, {
      method,
      headers: { ...(isForm ? {} : { "content-type": "application/json" }), ...authHeader },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      const text = await res.text();
      mapAddonRestriction(res.status, method, path, text);
      throw new Error(`Clockify ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
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
      throw new Error(
        `Clockify ${method} ${path} returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`,
      );
    }
  }

  // Loop list endpoints up to the MAX_PAGES backstop and report whether the
  // backstop (rather than a natural short page) ended the loop. `truncated: true`
  // means every one of the MAX_PAGES pages came back full, so there is almost
  // certainly more — the caller must surface that the list is incomplete rather
  // than reason over a silently-capped result. Warns once per truncated list so
  // the truncation is operator-visible even for callers that ignore the flag.
  async function paginateWithMeta(
    host: ClockifyHost,
    path: string,
    params: Record<string, string> = {},
  ): Promise<{ rows: unknown[]; truncated: boolean }> {
    const out: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const qs = new URLSearchParams({
        ...params,
        page: String(page),
        "page-size": String(PAGE_SIZE),
      });
      const sep = path.includes("?") ? "&" : "?";
      const rows = (await call(host, "GET", `${path}${sep}${qs.toString()}`)) as unknown[] | null;
      const arr = Array.isArray(rows) ? rows : [];
      out.push(...arr);
      if (arr.length < PAGE_SIZE) return { rows: out, truncated: false }; // short page = natural end
    }
    // Reached only if all MAX_PAGES pages were full → there is almost certainly more.
    console.warn(
      `Clockify list ${path} hit the ${MAX_PAGES}-page backstop (${out.length} rows); the result is truncated/incomplete.`,
    );
    return { rows: out, truncated: true };
  }

  async function paginate(
    host: ClockifyHost,
    path: string,
    params: Record<string, string> = {},
  ): Promise<unknown[]> {
    return (await paginateWithMeta(host, path, params)).rows;
  }

  async function getThenPut(
    host: ClockifyHost,
    path: string,
    patch: Record<string, unknown>,
  ): Promise<unknown> {
    const current = ((await call(host, "GET", path)) ?? {}) as Record<string, unknown>;
    const merged = { ...current, ...patch };
    return call(host, "PUT", path, merged);
  }

  async function postForm(
    host: ClockifyHost,
    path: string,
    fields: Record<string, string | Blob>,
  ): Promise<unknown> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    return call(host, "POST", path, form);
  }

  async function getBinary(
    host: ClockifyHost,
    path: string,
  ): Promise<{ contentType: string; bytes: Uint8Array }> {
    const res = await fetchWithRetry("GET", path, `${resolveHost(host)}${path}`, { method: "GET", headers: { ...authHeader } });
    if (!res.ok) {
      const text = await res.text();
      mapAddonRestriction(res.status, "GET", path, text);
      throw new Error(`Clockify GET ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { contentType: res.headers.get("content-type") ?? "application/octet-stream", bytes };
  }

  return { call, paginate, paginateWithMeta, getThenPut, postForm, getBinary };
}
