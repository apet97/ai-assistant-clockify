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
const PAGE_SIZE = 200;
/** Hard ceiling on pagination loops (200 * 50 = 10k rows) — a runaway backstop. */
const MAX_PAGES = 50;

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
  const doFetch = opts.fetchImpl ?? fetch;
  const authHeader: Record<string, string> =
    "addonToken" in opts.auth
      ? { "X-Addon-Token": opts.auth.addonToken }
      : { "X-Api-Key": opts.auth.apiKey };

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
    const res = await doFetch(`${baseHost}${path}`, {
      method,
      headers: { ...(isForm ? {} : { "content-type": "application/json" }), ...authHeader },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Clockify ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async function paginate(
    host: ClockifyHost,
    path: string,
    params: Record<string, string> = {},
  ): Promise<unknown[]> {
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
      if (arr.length < PAGE_SIZE) break;
    }
    return out;
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
    const res = await doFetch(`${resolveHost(host)}${path}`, { method: "GET", headers: { ...authHeader } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Clockify GET ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { contentType: res.headers.get("content-type") ?? "application/octet-stream", bytes };
  }

  return { call, paginate, getThenPut, postForm, getBinary };
}
