# Plan 008: Implement the chat-history switcher (reopen past conversations)

> **Executor instructions**: Read `plans/007-chat-history-switcher-INVESTIGATION.md`
> FIRST — it has the session model, the safety analysis, and the scope ruling.
> Then execute the phases below in order. Each phase is **TDD** (failing test
> first) and ends in **one commit** after `npm run verify` is green. If anything
> in "STOP conditions" occurs, stop and report. Update `plans/README.md` when
> done. This plan is what the `implement-chat-history-switcher` workflow drives,
> one phase per agent.
>
> **Drift check (run first)**: `git diff --stat 7826299..HEAD -- src/db/store.ts src/db/schema.ts src/routes/api.ts src/ui/main.ts src/ui/render.ts`
> If any changed since this plan was written, compare the excerpts below to the
> live code; on a mismatch, STOP.

## Status

- **Priority**: P2 (feature)
- **Effort**: L (6 phases)
- **Risk**: MED (touches auth/session re-bind — one IDOR guard is critical)
- **Depends on**: plan 006 (graceful empty restore — a switched-to empty/older
  session must restore cleanly). Land 006 first.
- **Category**: direction (feature)
- **Planned at**: commit `7826299`, 2026-06-14

## Why this matters

"New chat" preserves prior conversations server-side but the UI can't reopen
them (`src/ui/main.ts:649-651`). This adds a header **"Chats ▾"** dropdown that
lists the admin's recent conversations and reopens one on click — closing that
gap. Scope is **live (≤8h) owned sessions only** (see investigation §3); it does
NOT change the session TTL or revive expired sessions (that intersects the
human-gated `authz-surface-01` decision).

## Repo conventions (apply throughout)

- TypeScript ESM — every relative import ends in `.js`.
- SQLite via `better-sqlite3`; all admin-scoped rows carry `workspace_id` +
  `admin_user_id`; timestamps are ISO-8601 UTC strings.
- UI: pure DOM builders, text via `textContent` ONLY (never `innerHTML`); strong
  a11y (roles, `aria-*`, keyboard). Model after `src/ui/render.ts`.
- TDD: failing test first; `npm run verify` (judge by exit code) green before each
  commit; `npm run cycles` = 0. Conventional Commits.
- Tenant isolation: every new query/route is scoped by workspace **and** admin.

## Commands you will need

| Purpose       | Command                                              | Expected |
|---------------|------------------------------------------------------|----------|
| Typecheck     | `npm run type-check`                                 | exit 0   |
| One test file | `npx vitest run <path>`                              | pass     |
| Full gate     | `npm run verify`                                     | exit 0   |
| Cycles        | `npm run cycles`                                     | 0 cycles |
| Find patterns | `grep -rn "<symbol>" src tests`                      | seams    |

---

## Phase 1 — Store: `listSessions` + index + types

**Files**: `src/db/store.ts`, `src/db/schema.ts`, `tests/unit/store-sessions.test.ts` (create).

### Current state
- `chat_sessions(id, workspace_id, admin_user_id, created_at, last_seen_at, expires_at)` (`schema.ts:31-38`); only `PRIMARY KEY(id)` — no lookup index.
- `createSession`/`getSession` at `store.ts:546-594`; the `Store` interface block is `store.ts:185-194`.
- `getRecentMessages` shows the row-mapping style (`store.ts:612-636`).

### Steps
1. **RED**: in `tests/unit/store-sessions.test.ts`, drive a real in-memory store
   (model after `tests/unit/store.test.ts`): create two sessions for
   `(ws1, adminA)`, add a user message to each (different times), plus (a) an
   empty session, (b) an expired session (`createSession({…, ttlMs: -1000})` or
   set expiry in the past), (c) a session for `(ws1, adminB)`, (d) one for
   `(ws2, adminA)`. Assert `listSessions("ws1","adminA", nowIso)` returns ONLY
   the two non-empty live owned sessions, **newest-first**, each with
   `{ id, title, messageCount, lastMessageAt }` where `title` = the first user
   message. Confirm it FAILS (method absent).
2. **GREEN**: add to the `Store` interface and implementation:
   ```ts
   // interface (store.ts ~185-194):
   listSessions(workspaceId: string, adminUserId: string, nowIso: string): SessionSummary[];
   // + export interface SessionSummary { id: string; title: string; messageCount: number; lastMessageAt: string; createdAt: string; }
   ```
   ```ts
   // implementation (near getSession):
   listSessions(workspaceId, adminUserId, nowIso) {
     const rows = db.prepare(
       `SELECT s.id AS id, s.created_at AS created_at,
          (SELECT m.content FROM chat_messages m
             WHERE m.session_id = s.id AND m.role = 'user'
             ORDER BY m.created_at ASC, m.rowid ASC LIMIT 1) AS title,
          (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS message_count,
          (SELECT MAX(m.created_at) FROM chat_messages m WHERE m.session_id = s.id) AS last_message_at
        FROM chat_sessions s
        WHERE s.workspace_id = ? AND s.admin_user_id = ? AND s.expires_at > ?
        ORDER BY last_message_at DESC`,
     ).all(workspaceId, adminUserId, nowIso) as Array<{
       id: string; created_at: string; title: string | null; message_count: number; last_message_at: string | null;
     }>;
     return rows
       .filter((r) => r.message_count > 0 && r.last_message_at)
       .map((r) => ({
         id: r.id,
         title: r.title ?? "Conversation",
         messageCount: r.message_count,
         lastMessageAt: r.last_message_at as string,
         createdAt: r.created_at,
       }));
   }
   ```
   Add the lookup index to `SCHEMA_STATEMENTS` (all referenced columns exist at
   table creation, so it is safe there, beside the other lookup indexes ~line 78):
   ```sql
   CREATE INDEX IF NOT EXISTS idx_chat_sessions_workspace_admin_expires
     ON chat_sessions(workspace_id, admin_user_id, expires_at)
   ```
3. **Verify**: `npx vitest run tests/unit/store-sessions.test.ts` → green; `npm run verify` → exit 0.
4. **Commit**: `feat(store): list a workspace admin's live non-empty chat sessions`.

---

## Phase 2 — Route: `GET /api/chat/sessions`

**Files**: `src/routes/api.ts`, `tests/integration/chat-sessions.test.ts` (create).

### Current state
- `GET /chat/history` (`api.ts:1155`) is the pattern: `const claims = requireSession(req,res); if (!claims) return; … res.json({ ok:true, … })`.
- `now()` is the route's clock helper; `requireSession` returns scoped claims.

### Steps
1. **RED**: integration test (model after `tests/integration/chat-history.test.ts`):
   with a session for `(ws, adminA)` that has 2 conversations, `GET
   /api/chat/sessions` returns `{ ok:true, sessions:[…] }` newest-first, each
   `{ id, title, messageCount, lastMessageAt, current }` with `current===true`
   for the cookie's session; **no session cookie → 401**. Confirm it FAILS (404,
   route absent).
2. **GREEN**: add the route in `apiRouter`:
   ```ts
   router.get("/chat/sessions", (req, res) => {
     const claims = requireSession(req, res);
     if (!claims) return;
     const sessions = deps.store
       .listSessions(claims.workspaceId, claims.adminUserId, now().toISOString())
       .map((s) => ({ ...s, current: s.id === claims.sessionId }));
     res.json({ ok: true, sessions });
   });
   ```
3. **Verify**: `npx vitest run tests/integration/chat-sessions.test.ts` → green; `npm run verify` → exit 0.
4. **Commit**: `feat(api): GET /chat/sessions lists the admin's conversations`.

---

## Phase 3 — Route: `POST /api/chat/sessions/:id/open` (the switch) — **the IDOR guard is the point**

**Files**: `src/routes/api.ts`, `tests/integration/chat-sessions.test.ts` (extend).

### Current state
- `/chat/new` (`api.ts:1198-1218`) is the cookie-rebind template.
- Ownership check pattern: `resolveSession` (`deps.ts:74`) and component reuse
  (`component.ts:123-126`): `target.workspaceId===claims.workspaceId && target.adminUserId===claims.adminUserId`.
- `getSession` returns `undefined` for expired/missing — so expired ids 404 for free.

### Steps
1. **RED (write the IDOR test FIRST — it's the critical one)**: in the same
   integration file, create a session owned by `(ws, adminB)` (or `(ws2, adminA)`)
   and assert that `(ws, adminA)`'s cookie calling
   `POST /api/chat/sessions/<adminB's session id>/open` returns **404** and does
   NOT set a session cookie. Then the happy path: switching to adminA's OWN other
   session returns `{ ok:true }`, sets a `Set-Cookie`, and a subsequent
   `GET /api/chat/history` (with the new cookie) replays THAT session's messages.
   Also: an unknown/expired id → 404. Confirm RED.
2. **GREEN**:
   ```ts
   router.post("/chat/sessions/:id/open", (req, res) => {
     const claims = requireSession(req, res);
     if (!claims) return;
     const target = deps.store.getSession(req.params.id);
     // TENANT ISOLATION (IDOR guard): the target must be a LIVE session owned by
     // THIS admin + workspace. getSession already drops expired sessions; the
     // ownership check mirrors resolveSession / the component reuse gate. 404
     // (not 403) so existence is never confirmed to a probing caller.
     if (!target || target.workspaceId !== claims.workspaceId || target.adminUserId !== claims.adminUserId) {
       return res.status(404).json({ ok: false, code: "not_found", message: "Conversation not found." });
     }
     const sessionClaims: SessionClaims = {
       sessionId: target.id,
       workspaceId: claims.workspaceId,
       adminUserId: claims.adminUserId,
       workspaceRole: claims.workspaceRole,
       expiresAt: target.expiresAt, // the target's own expiry — never extended
     };
     const secure = deps.config.baseUrl.startsWith("https://");
     res.setHeader("Set-Cookie", buildSessionCookie(signSessionCookie(sessionClaims, deps.config.sessionSecret), secure));
     res.json({ ok: true });
   });
   ```
   (`SessionClaims`, `buildSessionCookie`, `signSessionCookie` are already
   imported in `api.ts` — reused by `/chat/new`.)
3. **Verify**: `npx vitest run tests/integration/chat-sessions.test.ts` → green (incl. the IDOR 404 test); `npm run verify` → exit 0.
4. **Commit**: `feat(api): POST /chat/sessions/:id/open switches to an owned session`.

> **STOP** if the IDOR test passes without the ownership check (it must not) or if
> any change is needed outside this route.

---

## Phase 4 — UI client: `listSessions` + `switchSession`

**Files**: `src/ui/main.ts`, `tests/unit/ui-*.test.ts` (extend an existing UI client test).

### Current state
- `ChatApi` interface (`main.ts:63-78`) + `createFetchApi()` (`main.ts:264-353`)
  with the `json()` helper (only 401 throws). `newChat` (`main.ts:269`) is the
  POST pattern.

### Steps
1. **RED**: unit test asserting `createFetchApi().listSessions()` GETs
   `/api/chat/sessions` and `switchSession(id)` POSTs
   `/api/chat/sessions/<encoded id>/open` (mock `fetch`; model after existing
   `createFetchApi` tests). Confirm RED.
2. **GREEN**: extend the `ChatApi` interface and `createFetchApi`:
   ```ts
   // interface:
   listSessions(): Promise<unknown>;
   switchSession(id: string): Promise<unknown>;
   // createFetchApi():
   listSessions: () => json("/api/chat/sessions"),
   switchSession: (id) => json(`/api/chat/sessions/${encodeURIComponent(id)}/open`, { method: "POST", body: JSON.stringify({}) }),
   ```
3. **Verify**: `npx vitest run <file>` → green; `npm run verify` → exit 0.
4. **Commit**: `feat(ui): add listSessions/switchSession to the chat API client`.

---

## Phase 5 — UI: the "Chats ▾" dropdown builder (pure, a11y, `textContent`)

**Files**: `src/ui/render.ts`, `tests/unit/ui-chats-menu.test.ts` (create), `src/ui/styles.css`.

### Current state
- `render.ts` builders take deps as params and use `el()`/`svgIcon()`; e.g.
  `renderClarify` (`render.ts:137`) and `renderPermissionTable` (`render.ts:67`).
- Add an icon path const (a chevron exists: `ICON_CHEVRON` at `render.ts:48`).

### Steps
1. **RED**: unit test (jsdom; model after `tests/unit/ui-*.test.ts`) for a new
   `renderChatsMenu(sessions, deps)` builder asserting: it renders one button per
   session with the **title via `textContent`** (inject a title containing
   `<img>` and assert it appears as text, not HTML); the `current` session is
   marked (e.g. `aria-current="true"` + a check icon); selecting a non-current
   item calls `deps.onSelect(id)`; the menu has `role="menu"` and items
   `role="menuitem"`; an empty list shows a "No past conversations" item. Confirm RED.
2. **GREEN**: implement `renderChatsMenu` in `render.ts` following the builder
   pattern — a toggle button (`aria-haspopup="menu"`, `aria-expanded`) + a
   `role="menu"` list; each item a `role="menuitem"` button whose label is the
   truncated title + a relative time; mark `current`; wire `onSelect`. Keyboard:
   Enter/Space select, Escape closes, Arrow Up/Down move focus (WCAG menu pattern).
   Add minimal styles to `styles.css` (reuse existing tokens/classes; the menu is
   a positioned panel under the toggle).
3. **Verify**: `npx vitest run tests/unit/ui-chats-menu.test.ts` → green; `npm run verify` → exit 0.
4. **Commit**: `feat(ui): chat-history dropdown builder (accessible, textContent-safe)`.

---

## Phase 6 — UI: wire the dropdown into the header + the switch flow

**Files**: `src/ui/main.ts`, (tests as feasible for the wiring), `src/ui/styles.css`.

### Current state
- `mount()` header (`main.ts:369-388`): H1 + `newChatButton` + `settingsButton`.
- `startNewChat()` (`main.ts:654-668`) is the "re-cookie → reset transcript →
  welcome → focus" pattern the switch reuses; `restoreHistory()` (`main.ts:675`)
  replays a session.

### Steps
1. Add a **"Chats ▾"** toggle button to the header (next to "New chat"), hidden
   until the chat is up (mirror `newChatButton`'s `hidden` handling at
   `main.ts:582`). On open, call `api.listSessions()`, build the menu via
   `renderChatsMenu`, and position it under the toggle.
2. On select: call `api.switchSession(id)`; on success, mirror `startNewChat`'s
   reset (`messages.replaceChildren()`, drop `.welcome`) then call
   `restoreHistory()` to replay the switched-to session; on failure, `showError`
   honestly and leave the current chat intact. Close the menu; return focus to the
   toggle (WCAG focus order, like the existing Confirm/Cancel focus return).
3. Refresh/append the list after `startNewChat` and after the first message of a
   fresh session so the menu stays current (optional polish — at minimum, rebuild
   on each open).
4. **Verify**: `npm run verify` → exit 0; `npm run cycles` → 0.
5. **Commit**: `feat(ui): wire the chat-history dropdown into the header + switch flow`.

---

## Done criteria (whole feature)

ALL must hold:

- [ ] `store.listSessions` returns only live, owned, non-empty sessions, newest-first (unit-pinned).
- [ ] `GET /api/chat/sessions` is session-gated, scoped, marks `current`.
- [ ] `POST /api/chat/sessions/:id/open` **404s for a foreign/other-admin/expired id** (IDOR test) and re-cookies on success.
- [ ] The header shows a "Chats ▾" dropdown listing conversations; selecting one replays it; titles render via `textContent`; the menu is keyboard-accessible.
- [ ] `DEFAULT_SESSION_TTL_MS`, the session expiry checks, and the harness are **unchanged** (`git diff` shows no edits there).
- [ ] `npm run verify` exits 0; `npm run cycles` = 0.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:
- The IDOR ownership check can't be made to fail an other-admin/foreign switch
  (the guard isn't working) — this is a security gate, never ship it un-pinned.
- A phase needs to change `DEFAULT_SESSION_TTL_MS` or revive expired sessions to
  "work" — that's Option B, out of scope (investigation §3/§8); STOP.
- Any change is needed in `src/harness/*`, `src/assistant/*`, or the money paths.
- `npm run cycles` reports a new cycle.

## Maintenance notes

- Future "full history beyond 8h" (Option B) requires a session-TTL/revive
  decision tied to `authz-surface-01` — keep it out until that's made.
- Adjacent future work the data model now cheaply supports: rename/delete a
  conversation (the list endpoint is the natural home), and bumping
  `chat_sessions.last_seen_at` on activity (currently dead) if richer ordering is
  wanted.
- Reviewer: scrutinize Phase 3 hardest — confirm the ownership check mirrors
  `resolveSession`, the re-cookie carries the **target's** unextended expiry, and
  the IDOR test genuinely fails without the guard.
