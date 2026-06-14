# Plan 004: Signal pagination truncation instead of silently capping lists at 10k rows

> **Executor instructions**: Follow this plan step by step. It has two parts —
> Part A (core, low-risk) makes truncation observable for ALL lists; Part B
> (entries path) surfaces it to the model for the one list where 10k is
> realistic. Write the failing/updated test before each behavior change. Run
> every verification command. If anything in "STOP conditions" occurs, stop and
> report. When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7826299..HEAD -- src/clockify/rest/core.ts tests/unit/rest-core.test.ts src/clockify/rest/time-entries.ts src/clockify/ports/time-entries.ts src/harness/workflows/entries.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts to the live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (Part A) / MED (Part B — changes a port return type)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `7826299`, 2026-06-14

## Why this matters

`core.paginate` loops list endpoints up to a `MAX_PAGES` (50) backstop —
`50 × PAGE_SIZE(200) = 10,000` rows. The backstop is a deliberate anti-runaway
guard, but when a real list exceeds 10k rows the loop **returns the first 10,000
with no signal at all**: no flag, no warning, no log. The model (and the admin)
then reason over a silently-incomplete list — wrong totals ("hours this year ="
X computed on truncated data), or "no entry matches Y" when Y is in the dropped
tail. For a tool whose entire value is accurate answers about Clockify data,
silent truncation is a correctness-of-answer bug. The team's own test even
documents the gap: *"a workspace with > 10k rows is silently cut off … with no
warning marker."* This plan keeps the backstop but makes truncation **visible**
— mirroring the existing `exportInvoice` pattern, which already returns a
`truncated` flag plus a receipt `warnings` caveat when a PDF exceeds its cap.

## Current state

- `src/clockify/rest/core.ts` — the shared pagination primitive and its
  constants:

  ```ts
  /** Page size used by `paginate`; Clockify's per-page cap for list endpoints. */
  export const PAGE_SIZE = 200;
  /** Hard ceiling on pagination loops (200 * 50 = 10k rows) — a runaway backstop. */
  export const MAX_PAGES = 50;
  // …
  async function paginate(
    host: ClockifyHost,
    path: string,
    params: Record<string, string> = {},
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const qs = new URLSearchParams({ ...params, page: String(page), "page-size": String(PAGE_SIZE) });
      const sep = path.includes("?") ? "&" : "?";
      const rows = (await call(host, "GET", `${path}${sep}${qs.toString()}`)) as unknown[] | null;
      const arr = Array.isArray(rows) ? rows : [];
      out.push(...arr);
      if (arr.length < PAGE_SIZE) break;   // ← short page = natural end
    }
    return out;                            // ← reached MAX_PAGES = SILENT truncation
  }
  ```

  The `RestCore` interface (top of the file) declares
  `paginate(host, path, params?): Promise<unknown[]>`. There are ~10 call sites
  across 8 files in `src/clockify/rest/*` (custom-fields, projects, scheduling,
  clients, time-entries, approvals, tasks, tags) — they all do
  `const rows = await core.paginate(...)`.

- `tests/unit/rest-core.test.ts` (lines ~208-230) — the existing test that pins
  the backstop and explicitly notes "no warning marker" / "truncated silently":

  ```ts
  it("paginate stops at the MAX_PAGES backstop (50) and truncates a runaway list to 10k rows", async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) => ({ id: i }));
    const fetchImpl = vi.fn(async () => res(fullPage));
    const core = createRestCore({ apiBase: "https://api.clockify.me/api/v1", auth: { apiKey: "k" }, fetchImpl: fetchImpl as unknown as typeof fetch });
    const rows = await core.paginate("api", "/workspaces/ws-1/time-entries");
    expect(fetchImpl).toHaveBeenCalledTimes(50);
    expect(rows).toHaveLength(10000); // PAGE_SIZE * MAX_PAGES, truncated silently
    // …
  });
  ```

- `src/clockify/ports/time-entries.ts` — `getEntries` returns a bare array:

  ```ts
  getEntries(input: {
    userId: string; start?: string; end?: string; projectId?: string; taskId?: string;
  }): Promise<TimeEntrySummary[]>;
  ```

- `src/clockify/rest/time-entries.ts` (lines ~80-88) — the adapter:

  ```ts
  async getEntries({ userId, start, end, projectId, taskId }) {
    const params: Record<string, string> = {};
    if (start) params.start = start;
    if (end) params.end = end;
    if (projectId) params.project = projectId;
    if (taskId) params.task = taskId;
    const rows = await core.paginate("api", `${ws}/user/${userId}/time-entries`, params);
    return (rows as ClockifyTimeEntry[]).map(mapEntry);
  },
  ```

- `src/harness/workflows/entries.ts` (lines ~70-90) — the `clockify_entries_list`
  action consuming it:

  ```ts
  const items = await ctx.clockify.getEntries({ userId, start, end, projectId: refs.projectId, taskId: refs.taskId });
  return {
    kind: "receipt",
    receipt: successReceipt({
      action: "clockify_entries_list",
      entity: "time_entry",
      ids: { workspaceId: ctx.workspaceId },
      data: { userId, count: items.length, items, ...(start !== undefined || end !== undefined ? { window: { start, end } } : {}) },
    }),
  };
  ```

- **Precedent to mirror** — `src/harness/workflows/invoices.ts` (~lines 250-256),
  the export already does exactly this shape:

  ```ts
  data: { contentType: exp.contentType, bytes: exp.bytes, truncated: exp.truncated, base64: exp.base64 },
  warnings: exp.truncated
    ? [{ code: "export_truncated", message: /* … honest caveat … */ }]
    : undefined,
  ```

- `SuccessReceipt` already supports `warnings?: Warning[]` where
  `Warning = { code?: string; message: string }` (`src/harness/receipts.ts`).

- Conventions: ESM (`.js` import suffixes); Conventional Commits; TDD
  (failing/updated test first). Logging = message only.

## Commands you will need

| Purpose          | Command                                                 | Expected          |
|------------------|---------------------------------------------------------|-------------------|
| Core test        | `npx vitest run tests/unit/rest-core.test.ts`           | all pass          |
| Time-entries test| `npx vitest run tests/unit/rest-time-entries.test.ts`   | all pass (if present) |
| Entries workflow | `npx vitest run tests/integration/entries.test.ts`      | all pass (adjust filename) |
| Find callers     | `grep -rn "\.paginate(\|getEntries(" src tests`        | the sites to touch |
| Full gate        | `npm run verify`                                        | exit 0            |

## Scope

**In scope**:
- Part A: `src/clockify/rest/core.ts` (add `paginateWithMeta`, keep `paginate`
  as a wrapper, warn on truncation) + `tests/unit/rest-core.test.ts` (update the
  existing backstop test + add a non-truncated case).
- Part B: `src/clockify/ports/time-entries.ts` (`getEntries` return type),
  `src/clockify/rest/time-entries.ts` (`getEntries` impl), the fake
  implementation of `getEntries` (locate via
  `grep -rn "getEntries" tests/helpers`), `src/harness/workflows/entries.ts`
  (surface the caveat), and the entries-list test(s) (locate via
  `grep -rln "clockify_entries_list\|getEntries" tests`).
- `plans/README.md` (status row).

**Out of scope** (do NOT touch):
- The 7 OTHER `paginate` callers' return types (projects, clients, tags, tasks,
  approvals, scheduling, custom-fields). They keep calling `paginate` (unchanged
  signature) and get observability for free via the warn in Part A. Threading a
  receipt caveat into each of those is a deliberate follow-up, not this plan
  (see Maintenance notes) — time entries is the only list where 10k is
  realistically reachable for one user.
- `MAX_PAGES` / `PAGE_SIZE` values — do NOT raise the cap; the fix is the
  signal, not a bigger ceiling.

## Git workflow

- Branch `advisor/004-pagination-truncation`, or direct-commit per your
  workflow. Do NOT push/PR unless instructed.
- Suggested commits: `feat(clockify): expose pagination truncation via paginateWithMeta`
  (Part A), then `feat(clockify): warn when an entries list is truncated at the
  backstop` (Part B).

## Steps

### Part A — make truncation observable in the core

#### Step A1: Add `paginateWithMeta` and reduce `paginate` to a wrapper

In `src/clockify/rest/core.ts`:

1. Add to the `RestCore` interface:
   ```ts
   /** Like paginate, but reports whether the MAX_PAGES backstop truncated the list. */
   paginateWithMeta(
     host: ClockifyHost,
     path: string,
     params?: Record<string, string>,
   ): Promise<{ rows: unknown[]; truncated: boolean }>;
   ```

2. Implement it (the real loop), and make `paginate` delegate. Truncation is the
   exact condition "every one of the MAX_PAGES pages was full" (the loop never
   hit the short-page break):
   ```ts
   async function paginateWithMeta(host, path, params = {}) {
     const out: unknown[] = [];
     for (let page = 1; page <= MAX_PAGES; page++) {
       const qs = new URLSearchParams({ ...params, page: String(page), "page-size": String(PAGE_SIZE) });
       const sep = path.includes("?") ? "&" : "?";
       const rows = (await call(host, "GET", `${path}${sep}${qs.toString()}`)) as unknown[] | null;
       const arr = Array.isArray(rows) ? rows : [];
       out.push(...arr);
       if (arr.length < PAGE_SIZE) return { rows: out, truncated: false };
     }
     // Reached only if all MAX_PAGES pages were full → there is almost certainly more.
     console.warn(
       `Clockify list ${path} hit the ${MAX_PAGES}-page backstop (${out.length} rows); the result is truncated/incomplete.`,
     );
     return { rows: out, truncated: true };
   }
   async function paginate(host, path, params = {}) {
     return (await paginateWithMeta(host, path, params)).rows;
   }
   ```
   Add `paginateWithMeta` to the returned object at the bottom of
   `createRestCore` (alongside `paginate`).

**Verify**: `npm run type-check` → exit 0.

#### Step A2: Update the backstop test + add a non-truncated case

In `tests/unit/rest-core.test.ts`, update the existing "paginate stops at the
MAX_PAGES backstop" test so it asserts the new signal (the `// truncated
silently` comment is now wrong):
- keep `expect(rows).toHaveLength(10000)` (via `paginate`);
- add `const meta = await core.paginateWithMeta("api", "/workspaces/ws-1/time-entries"); expect(meta.truncated).toBe(true); expect(meta.rows).toHaveLength(10000);`
- optionally spy on `console.warn` and assert it was called once with the path.

Add a sibling test: a list whose final page is short (e.g. 2 pages, second
returns < 200) → `paginateWithMeta(...)` returns `{ truncated: false }`.

**Verify**: `npx vitest run tests/unit/rest-core.test.ts` → all pass.

### Part B — surface the caveat to the model on the entries list

#### Step B1: Thread `truncated` through the entries port + adapter

- `src/clockify/ports/time-entries.ts`: change `getEntries`'s return type to
  `Promise<{ entries: TimeEntrySummary[]; truncated: boolean }>`.
- `src/clockify/rest/time-entries.ts`: update `getEntries` to use
  `paginateWithMeta` and return the new shape:
  ```ts
  const { rows, truncated } = await core.paginateWithMeta("api", `${ws}/user/${userId}/time-entries`, params);
  return { entries: (rows as ClockifyTimeEntry[]).map(mapEntry), truncated };
  ```
- Update the **fake** implementation of `getEntries` (find it:
  `grep -rn "getEntries" tests/helpers`) to return `{ entries: [...], truncated: false }`.

**Verify**: `npm run type-check` → it will flag the workflow + any test that
still treats `getEntries` as returning an array. Fix those in B2/B3.

#### Step B2: Surface the caveat in the `clockify_entries_list` action

In `src/harness/workflows/entries.ts`, destructure the new shape and add the
caveat (mirror the `exportInvoice` precedent — `truncated` in `data` + a
`warnings` entry):
```ts
const { entries: items, truncated } = await ctx.clockify.getEntries({ userId, start, end, projectId: refs.projectId, taskId: refs.taskId });
return {
  kind: "receipt",
  receipt: successReceipt({
    action: "clockify_entries_list",
    entity: "time_entry",
    ids: { workspaceId: ctx.workspaceId },
    data: { userId, count: items.length, items, ...(truncated ? { truncated: true } : {}), ...(start !== undefined || end !== undefined ? { window: { start, end } } : {}) },
    warnings: truncated
      ? [{ code: "list_truncated", message: `Showing the first ${items.length} time entries (the maximum fetched at once); there may be more. Narrow the date window or add a project filter to see the rest.` }]
      : undefined,
  }),
};
```

**Verify**: `npm run type-check` → exit 0.

#### Step B3: Update entries tests

Find the entries-list test(s) (`grep -rln "clockify_entries_list\|getEntries" tests`)
and:
- fix any assertion that expected `getEntries` to return a bare array (now
  `{ entries, truncated }`) — in the fake/setup and assertions;
- add a case: a fake `getEntries` returning `{ entries: […], truncated: true }`
  produces a receipt whose `warnings` contains a `list_truncated` entry and
  whose `data.truncated === true`.

**Verify**: `npx vitest run <the entries test file>` → all pass.

### Step C: Full verification

**Verify**: `npm run verify` → exit 0 (type-check + full suite + build + cycles
once plan 001 lands; otherwise also run `npm run cycles`).

## Test plan

- Updated `tests/unit/rest-core.test.ts`: the backstop case now asserts
  `paginateWithMeta(...).truncated === true`; a new case asserts `false` on a
  short final page.
- Entries workflow test: a truncated `getEntries` result yields a
  `list_truncated` warning + `data.truncated`; a normal result yields neither.
- Regression: the existing suite stays green (the 7 other `paginate` callers are
  unaffected — `paginate`'s signature is unchanged).

## Done criteria

ALL must hold:

- [ ] `core.paginateWithMeta` exists, returns `{ rows, truncated }`, and warns
      once when it truncates; `paginate` still returns `unknown[]`.
- [ ] `tests/unit/rest-core.test.ts` asserts `truncated === true` at the
      backstop and `false` otherwise; the "truncated silently" comment is gone.
- [ ] `clockify_entries_list` emits a `list_truncated` warning + `data.truncated`
      when the entries list hits the backstop, and neither when it doesn't.
- [ ] `grep -rn "\.paginate(" src/clockify/rest` shows the other 7 callers
      unchanged.
- [ ] `npm run verify` exits 0 (and `npm run cycles` is clean).
- [ ] `git status` shows only in-scope files changed.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- Changing `getEntries`'s return type ripples beyond the files listed in Scope
  (port, rest adapter, the one workflow, the fake, the entries tests). If a
  second production caller of `getEntries` exists, STOP and report it — there
  may be a consumer this plan didn't account for.
- `npm run cycles` reports a new cycle.
- The "Current state" excerpts don't match the live code.

## Maintenance notes

- The same `paginateWithMeta` + receipt-caveat pattern extends to the other
  paginated lists (projects, clients, tasks, tags, approvals, scheduling) if a
  workspace ever makes them exceed 10k. They already get an operator-visible
  `console.warn` from Part A; only the model-facing caveat is entries-only for
  now. Document any future extension the same way (no silent caps).
- A larger follow-up could replace the 10k cap with real cursor pagination
  ("fetch the next batch") — but that's a feature, not this fix. The caveat is
  the right first step.
- Reviewer: confirm the cap value is unchanged, the warn fires exactly once per
  truncated list, and the 7 unrelated callers are untouched.
