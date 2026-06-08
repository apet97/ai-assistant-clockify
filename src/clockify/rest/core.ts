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
 * The sibling hosts are DERIVED from the verified backend base (never hardcode
 * the tenant — see CLAUDE.md). The token/key is sent only in the request header
 * — never logged, never placed in a prompt, never returned.
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

function hostsFor(apiBase: string): Record<ClockifyHost, string> {
  // https://api.clockify.me/api/v1 -> reports.api.clockify.me/v1, auditlog-api.api.clockify.me/v1
  const u = new URL(apiBase);
  const root = u.host.replace(/^api\./, ""); // clockify.me
  return {
    api: apiBase.replace(/\/$/, ""),
    reports: `${u.protocol}//reports.api.${root}/v1`,
    audit: `${u.protocol}//auditlog-api.api.${root}/v1`,
  };
}

export function createRestCore(opts: RestCoreOptions): RestCore {
  const derived = hostsFor(opts.apiBase);
  // The reports/audit hosts vary by environment (prod subdomain vs dev path), so
  // an explicit base from the token claim wins over the derived prod default.
  const hosts: Record<ClockifyHost, string> = {
    api: derived.api,
    reports: opts.reportsBase ?? derived.reports,
    audit: opts.auditBase ?? derived.audit,
  };
  const doFetch = opts.fetchImpl ?? fetch;
  const authHeader: Record<string, string> =
    "addonToken" in opts.auth
      ? { "X-Addon-Token": opts.auth.addonToken }
      : { "X-Api-Key": opts.auth.apiKey };

  async function call(
    host: ClockifyHost,
    method: string,
    path: string,
    body?: unknown,
    allow404 = false,
  ): Promise<unknown> {
    // multipart/form-data bodies must NOT carry a JSON content-type — fetch/undici
    // sets the multipart boundary itself when the body is a FormData.
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const res = await doFetch(`${hosts[host]}${path}`, {
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
    const res = await doFetch(`${hosts[host]}${path}`, { method: "GET", headers: { ...authHeader } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Clockify GET ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { contentType: res.headers.get("content-type") ?? "application/octet-stream", bytes };
  }

  return { call, paginate, getThenPut, postForm, getBinary };
}
