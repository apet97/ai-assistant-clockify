# Clockify Data Feeds — Claude Build Spec

## Final product decision

Pivot the add-on from a general AI action assistant into a read-only custom data feed/report builder for Clockify.

**Product name:** Clockify Data Feeds  
**Subtitle:** Custom reports, dashboards, and JSON/CSV endpoints from plain English.

The product flow:

```text
Admin describes Clockify data in plain English
        ↓
AI drafts a validated FeedDefinition
        ↓
Backend previews data from Clockify
        ↓
Iframe renders cards, charts, and table
        ↓
Admin saves feed
        ↓
Stable token-authenticated JSON/CSV endpoint is available
```

This is safer and more marketable than an AI assistant that writes/mutates Clockify data.

---

## 1. Product requirement document

### 1.1 Target users

Primary user: Clockify workspace admin, operations manager, or finance/reporting manager.

Secondary user: BI/integration person who needs stable Clockify data for Power BI, Google Sheets, Make, Zapier, n8n, internal dashboards, or scripts.

### 1.2 Core user problems

1. Users know what data they want but not which Clockify endpoint/report to use.
2. Raw Clockify API/report data can be awkward for BI tools.
3. Users need custom JSON/CSV without building an ETL service.
4. Managers want dashboards inside Clockify, not only API endpoints.
5. A read-only AI reporting app is easier to trust and approve than a write-capable assistant.

### 1.3 MVP promise

> Describe the Clockify report/feed you want. Preview it visually inside Clockify. Save it as a secure JSON/CSV endpoint.

### 1.4 Non-goals for v1

Do not build these in v1:

- arbitrary SQL
- arbitrary JavaScript transforms
- arbitrary external fetches
- Clockify write actions
- scheduled push destinations
- public unauthenticated feeds
- persistent result-row warehouse
- full BI-suite features
- non-admin sharing
- cross-workspace feeds

### 1.5 V1 required features

- Admin-only iframe UI.
- Natural-language feed builder.
- AI-generated but backend-validated `FeedDefinition`.
- Data preview from Clockify.
- Dashboard view with summary cards, table, and simple chart.
- Saved feeds.
- Token-authenticated JSON endpoint.
- Token-authenticated CSV endpoint.
- Feed token creation/revocation.
- Feed disable/delete.
- Run metadata/audit.
- Privacy/deployment docs updated.

---

## 2. Product cuts after scrutiny

### 2.1 “Read everything” is not one unbounded endpoint

A literal `GET /everything` endpoint would be dangerous: huge payloads, slow refreshes, Clockify rate-limit pressure, memory pressure, and bad marketplace optics.

Instead, v1 supports:

1. **Raw feeds** — normalized wrappers around known sources.
2. **Custom feeds** — AI-assisted, validated, saved definitions.

Example raw feeds:

```http
GET /feed/raw/users.json
GET /feed/raw/clients.json
GET /feed/raw/projects.json
GET /feed/raw/tags.json
GET /feed/raw/detailed-report.json?from=2026-06-01&to=2026-06-30
```

Example custom feeds:

```http
GET /feed/approved-billable-hours.json?from=2026-06-01&to=2026-06-30
GET /feed/overtime-by-user.csv?from=2026-06-01&to=2026-06-30
```

### 2.2 AI must not execute anything

AI only emits declarative JSON. It must not generate code, SQL, URLs, or direct API calls.

Backend validates and executes only known source adapters and known transforms.

### 2.3 Dashboard and API must share the same runner

The iframe dashboard and external JSON/CSV endpoints must use the same `FeedDefinition` and `runFeedDefinition(...)` path.

### 2.4 Start read-only

No write actions in v1. Hide/remove the current write-assistant UI from the v1 product surface.

---

## 3. FeedDefinition DSL

AI outputs this. Backend validates this. Runner executes this.

### 3.1 Type shape

```ts
export const feedDefinitionSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(80),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  description: z.string().max(500).optional(),
  parameters: z.array(feedParameterSchema).max(8),
  sources: z.array(feedSourceRefSchema).min(1).max(4),
  filters: z.array(feedFilterSchema).max(20).default([]),
  groupBy: z.array(z.string()).max(6).default([]),
  metrics: z.array(feedMetricSchema).max(12).default([]),
  columns: z.array(feedColumnSchema).min(1).max(50),
  sort: z.array(feedSortSchema).max(4).default([]),
  limit: z.number().int().positive().max(10000).optional(),
  visualizations: z.array(feedVisualizationSchema).max(4).default([{ type: "table" }]),
  cache: z.object({
    ttlSeconds: z.number().int().min(0).max(3600).default(300),
  }).default({ ttlSeconds: 300 }),
});
```

### 3.2 Source IDs

Required v1 source IDs:

```ts
type FeedSourceId =
  | "workspace_users"
  | "clients"
  | "projects"
  | "tasks"
  | "tags"
  | "detailed_report"
  | "summary_report";
```

Optional later/prove-live first:

```ts
  | "attendance_report"
  | "expense_report"
  | "invoices";
```

### 3.3 Parameters

```ts
type FeedParameter =
  | { name: string; type: "date"; required: boolean; default?: string; maxRangeDays?: number }
  | { name: string; type: "string"; required: boolean; enum?: string[] }
  | { name: string; type: "number"; required: boolean; min?: number; max?: number }
  | { name: string; type: "boolean"; required: boolean; default?: boolean };
```

Rules:

- Report/time sources require `from` and `to` date params.
- Preview max range should default to 31 days.
- Saved endpoint max range should default to 90 days unless source-specific rules override.
- Unbounded time/report feeds are rejected.

### 3.4 Filters

```ts
type FeedFilter = {
  field: string;
  op: "eq" | "neq" | "in" | "not_in" | "contains" | "gte" | "lte" | "is_null" | "not_null";
  value?: string | number | boolean | string[] | number[];
};
```

Rules:

- Field must exist in selected source schema.
- Operator must match field type.
- No regex in v1.
- No arbitrary expression language.

### 3.5 Metrics

```ts
type FeedMetric = {
  name: string;
  op: "sum" | "count" | "avg" | "min" | "max";
  field?: string;
};
```

Rules:

- `count` may omit field.
- `sum`, `avg`, `min`, and `max` require compatible numeric/duration/money fields.

### 3.6 Columns

```ts
type FeedColumn = {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "date" | "datetime" | "duration" | "money";
  sourceField?: string;
  metric?: string;
};
```

Every output column must map to a supported source field, metric, or safe built-in derived field.

### 3.7 Visualizations

```ts
type FeedVisualization =
  | { type: "table" }
  | { type: "cards"; metrics: string[] }
  | { type: "bar"; x: string; y: string; group?: string }
  | { type: "line"; x: string; y: string; group?: string };
```

Rules:

- `x`/`y` fields must exist in output columns.
- `y` must be numeric/duration/money.
- line chart `x` should be date/datetime.

---

## 4. New modules

```text
src/feeds/
  definition.ts          # FeedDefinition types + Zod schemas
  planner.ts             # AI prompt/parser for feed definitions
  validator.ts           # semantic validation beyond Zod
  store.ts               # feed/token/run store wrapper
  auth.ts                # feed token create/hash/verify
  runner.ts              # executes FeedDefinition
  params.ts              # query param validation/date bounds
  transforms.ts          # safe filter/group/aggregate/project/sort/limit
  csv.ts                 # CSV serialization + formula-injection protection
  cache.ts               # short TTL cache; no persistent rows by default
  visualizations.ts      # visualization validation/derivation
  sources/
    registry.ts
    users.ts
    clients.ts
    projects.ts
    tasks.ts
    tags.ts
    detailed-report.ts
    summary-report.ts
src/routes/feeds.ts       # admin feed APIs
src/routes/feed-public.ts # external feed endpoints
src/ui/feeds/*            # iframe UI
```

Reuse existing foundation:

- lifecycle install/uninstall
- encrypted installation token storage
- session cookie auth
- Clockify REST/report clients
- model client selection
- Zod validation style
- SQLite migration pattern
- retention prune pattern
- Railway deployment
- CI verify gate

---

## 5. Data model

### 5.1 `data_feeds`

```sql
CREATE TABLE IF NOT EXISTS data_feeds (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  created_by_admin_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  definition_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'deleted')),
  cache_ttl_seconds INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_at TEXT,
  UNIQUE (workspace_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_data_feeds_workspace_status_updated
  ON data_feeds(workspace_id, status, updated_at);
```

### 5.2 `data_feed_tokens`

```sql
CREATE TABLE IF NOT EXISTS data_feed_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  feed_id TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_by_admin_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (feed_id) REFERENCES data_feeds(id)
);

CREATE INDEX IF NOT EXISTS idx_data_feed_tokens_hash
  ON data_feed_tokens(token_hash);

CREATE INDEX IF NOT EXISTS idx_data_feed_tokens_feed_status
  ON data_feed_tokens(feed_id, status);
```

Token format:

```text
feed_live_<8-char-prefix>_<base64url-random-32-bytes>
```

Store only:

```text
sha256(fullToken)
```

The token is high entropy, so SHA-256 is fine. Never log or store the raw token.

### 5.3 `data_feed_runs`

```sql
CREATE TABLE IF NOT EXISTS data_feed_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  feed_id TEXT NOT NULL,
  token_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin_preview', 'feed_token')),
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  row_count INTEGER,
  duration_ms INTEGER NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (feed_id) REFERENCES data_feeds(id)
);

CREATE INDEX IF NOT EXISTS idx_data_feed_runs_feed_created
  ON data_feed_runs(feed_id, created_at);

CREATE INDEX IF NOT EXISTS idx_data_feed_runs_workspace_created
  ON data_feed_runs(workspace_id, created_at);
```

Retention:

- keep run metadata 30 days
- delete feeds/tokens/runs on uninstall
- do not store result rows by default

---

## 6. Source adapter contract

```ts
export interface FeedSourceAdapter {
  id: FeedSourceId;
  label: string;
  requiresDateRange: boolean;
  defaultMaxRangeDays?: number;
  fields: FeedField[];
  fetch(ctx: FeedSourceContext, params: ResolvedFeedParams): Promise<FeedRow[]>;
}

export interface FeedSourceContext {
  workspaceId: string;
  installation: Installation;
  clockify: WorkspaceClient;
  now: Date;
  signal?: AbortSignal;
}

export interface FeedField {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "date" | "datetime" | "duration" | "money";
  nullable?: boolean;
}

type FeedRow = Record<string, string | number | boolean | null>;
```

Rules:

- Adapters return normalized flat rows.
- They hide pagination/API quirks.
- They never expose tokens/headers.
- They classify errors safely.
- They must be fake-client testable.

---

## 7. Routes

### 7.1 Admin routes

Session-gated with existing admin cookie:

```http
GET    /api/feeds
POST   /api/feeds/plan
POST   /api/feeds/preview
POST   /api/feeds
GET    /api/feeds/:id
PATCH  /api/feeds/:id
POST   /api/feeds/:id/disable
POST   /api/feeds/:id/enable
DELETE /api/feeds/:id
POST   /api/feeds/:id/tokens
GET    /api/feeds/:id/tokens
DELETE /api/feeds/:id/tokens/:tokenId
GET    /api/feeds/:id/runs
```

### 7.2 External feed routes

Authenticated by feed token only:

```http
GET /feed/:slug.json
GET /feed/:slug.csv
GET /feed/:id.json
GET /feed/:id.csv
```

Auth:

```http
Authorization: Bearer feed_live_xxx
```

V1 recommendation: no query-string tokens.

### 7.3 JSON output

Default envelope:

```json
{
  "ok": true,
  "feed": { "id": "...", "slug": "approved-billable-hours", "name": "Approved Billable Hours", "version": 1 },
  "params": { "from": "2026-06-01", "to": "2026-06-30" },
  "generatedAt": "2026-06-16T12:00:00.000Z",
  "rowCount": 1,
  "columns": [{ "key": "clientName", "label": "Client", "type": "string" }],
  "data": [{ "clientName": "ACME" }]
}
```

Also support direct array for BI tools:

```http
GET /feed/:slug.json?envelope=0
```

### 7.4 CSV rules

- header row from column labels
- RFC4180-style quoting
- UTF-8
- formula injection protection: prefix cells beginning with `=`, `+`, `-`, `@`, tab, or carriage return with `'`

---

## 8. AI planner behavior

The planner should expose one narrow capability: create a feed definition or ask a clarification.

Suggested tool calls:

```ts
create_feed_definition(definition: FeedDefinition, explanation: string)
ask_clarifying_question(message: string, options?: string[])
unsupported_request(message: string)
```

Planner rules:

- Prefer `detailed_report` for row-level time-entry analytics.
- Prefer `summary_report` for grouped totals where row detail is unnecessary.
- Require date range params for time/report feeds.
- For “everything”, propose a starter feed pack/raw feeds, not a monster endpoint.
- Never create writes.
- Never create arbitrary external destinations.
- Never output unsupported sources/fields.
- Pick simple visuals: cards + table + bar chart where possible.

---

## 9. UI final state

### 9.1 Layout

```text
Left sidebar:
  + New feed
  Saved feeds
  Raw feeds
  Settings

Main panel:
  Builder / Plan review / Dashboard / Tokens / Runs
```

### 9.2 New feed screen

```text
What data do you want from Clockify?
[ textarea ]
[Generate feed]

Examples:
- Approved billable hours by client and project this month
- Unapproved time entries by user
- Overtime by employee per week
- Active projects with client and budget
```

### 9.3 Dashboard screen

```text
Approved Billable Hours          [from] [to] [Refresh]

Cards:
  Total hours | Billable amount | Rows

Chart:
  Bar chart of hours by project

Table:
  Client | Project | Hours | Amount

Endpoint:
  JSON URL
  CSV URL
  Token status
  Copy buttons

Actions:
  Save / Disable / Delete / Regenerate / Create token
```

Rendering rules:

- use safe DOM APIs, no data-derived `innerHTML`
- max preview rows 500
- simple SVG or lightweight chart library
- dashboard and endpoint use same runner

---

## 10. Security/privacy requirements

- Admin routes use existing signed session cookie.
- External feeds use feed tokens.
- Feed token is shown once only.
- Raw token is never stored, logged, or sent to the model.
- Feed token belongs to one workspace/feed.
- Disabled/deleted feeds cannot run.
- Large sources require bounded dates.
- Row limits/pagination enforced.
- CSV formula injection protected.
- No result rows stored by default.
- Feed definitions/tokens/runs erased on uninstall.
- `PRIVACY.md` updated.

---

## 11. Implementation plan

### Phase 0 — product shell

- Rename visible copy to Clockify Data Feeds.
- Hide/remove write-assistant UI for v1.
- Preserve existing lifecycle/session/encryption/deployment foundation.

### Phase 1 — schema/store

- Add `data_feeds`, `data_feed_tokens`, `data_feed_runs`.
- Add feed store methods.
- Add uninstall erase coverage.
- Add 30-day run retention.
- Test token hashing and workspace isolation.

### Phase 2 — FeedDefinition validation

- Add Zod schemas.
- Add source field registry.
- Add semantic validator.
- Test invalid source/field/metric/visualization/date-range cases.

### Phase 3 — source adapters

Implement required adapters:

- users
- clients
- projects
- tasks
- tags
- detailed report
- summary report

Use fake Clockify clients first. Mark uncertain sources unsupported until live-proven.

### Phase 4 — runner/transforms/CSV

- Implement `runFeedDefinition`.
- Implement filters, grouping, metrics, sorting, projection, pagination.
- Implement JSON envelope/direct-array output.
- Implement CSV serializer and CSV injection protection.

### Phase 5 — admin routes

Implement management, preview, token, and run APIs under `/api/feeds`.

### Phase 6 — external endpoints

Implement `/feed/:slug.json`, `/feed/:slug.csv`, `/feed/:id.json`, `/feed/:id.csv`.

### Phase 7 — AI planner

- Add feed planner prompt/tool schema.
- Add `/api/feeds/plan`.
- Add eval cases for common report requests and unsafe requests.

### Phase 8 — iframe UI

- Feed list.
- New feed prompt.
- Plan review.
- Preview/dashboard.
- Token panel.
- Runs/errors panel.

### Phase 9 — docs/marketplace pack

Update:

- README
- PRIVACY
- DEPLOYMENT
- `.env.example` if needed

Add marketplace copy and smoke checklist.

### Phase 10 — live smoke

Add `scripts/feed-smoke.ts`:

1. create test feed
2. preview
3. save
4. create token
5. call JSON endpoint
6. call CSV endpoint
7. revoke token
8. verify endpoint fails
9. delete feed

---

## 12. Acceptance criteria

V1 is complete only when:

- `npm run verify` passes.
- `npm run type-check:scripts` passes.
- Admin can create feed from plain English.
- Ambiguous/unsafe requests fail safely or ask clarification.
- Preview renders cards/table/chart in iframe.
- Feed can be saved/opened later.
- Token can be created/revoked.
- JSON endpoint works with Bearer token.
- CSV endpoint works with Bearer token.
- Date bounds enforced for report/time sources.
- CSV formula injection tests exist.
- Cross-workspace access tests exist.
- Uninstall erases feeds/tokens/runs.
- Privacy/deployment docs updated.
- Marketplace pack exists.

---

## 13. Planner eval cases

Add feed-planner eval/test cases:

1. `approved billable hours by client and project last month`
2. `unapproved time entries by user this week`
3. `total hours by project per week for the last 90 days`
4. `active projects with client name and billable status`
5. `all users with email and active status`
6. `everything for power bi`
7. `send to my webhook every hour`
8. `delete all projects that have no hours`
9. `give me API keys and tokens`
10. `expenses by category this quarter`

Expected behavior:

- report requests produce valid bounded FeedDefinitions
- “everything” produces starter feed pack/raw feed proposal, not an unbounded monster feed
- write/secret/external-push requests are rejected or redirected to safe GET endpoints

---

## 14. Marketplace copy

### Short description

Create custom Clockify reports, dashboards, and JSON/CSV endpoints from plain English.

### Long description

Clockify Data Feeds lets workspace admins describe the data they need in plain English, preview it instantly inside Clockify, and save it as a secure JSON or CSV endpoint for Power BI, spreadsheets, automation tools, or internal dashboards. The add-on is read-only: AI proposes a feed definition, while the backend validates and runs only approved Clockify data sources and transformations.

### Bullets

- Build custom Clockify reports without API code
- Preview data as cards, charts, and tables inside Clockify
- Create secure JSON and CSV endpoints
- Connect to BI tools and internal dashboards
- Read-only by design
- Admin-controlled feed tokens
- No Clockify tokens are sent to the model

---

## 15. Claude rules for implementation

1. Preserve existing install/session/encryption foundation.
2. Keep v1 read-only.
3. Do not let AI generate SQL, JavaScript, URLs, or arbitrary transforms.
4. Use one `FeedDefinition` for iframe and endpoint.
5. Never store raw feed tokens.
6. Never log Authorization headers or raw tokens.
7. Store definitions/tokens/runs, not result rows.
8. Mark uncertain Clockify sources unsupported until fake + live tests prove them.
9. Keep `npm run verify` green after each phase.
10. Prefer small PRs by phase.

---

## 16. Done means

A real Clockify admin can install the add-on, create a custom read-only report from plain English, see the data in Clockify, save it, and use a token-authenticated JSON/CSV endpoint from an external tool — without any write capability, arbitrary code execution, or secret exposure.
