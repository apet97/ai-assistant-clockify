# Investigation 007: Chat-history switcher — deep design investigation

> **Purpose**: A self-contained, code-grounded investigation for the
> chat-history switcher (a header dropdown to reopen past conversations). It
> doubles as a **new-session orientation** for the session/conversation
> subsystem. Read this before executing plan `008` or running the
> `implement-chat-history-switcher` workflow. Everything here was verified
> against the code at commit `7826299` on 2026-06-14.

---

## 1. The problem (grounded)

The header has a **"New chat"** button (`src/ui/main.ts:374-378`, route
`POST /api/chat/new` at `src/routes/api.ts:1198`). Its own comment states the
gap precisely:

> "Start a new conversation: mint a fresh session … The previous chat is NOT
> deleted (it stays on the server under retention; the audit log keeps the
> actions) — only the UI resets."

So **every "New chat" orphans the prior conversation**: its messages live on
server-side, but the UI offers **no way to reopen them**. The chat-history
switcher closes that gap: a dropdown listing the admin's recent conversations,
clicking one re-opens it.

## 2. New-session orientation — the subsystems involved

| Concern | File | What it does |
|--------|------|--------------|
| Session identity | `src/auth/sessions.ts` | Signs/verifies the HMAC session cookie. Claims = `{ sessionId, workspaceId, adminUserId, workspaceRole, expiresAt }`. |
| Cookie + resolve | `src/routes/deps.ts` | `buildSessionCookie` (HttpOnly; `SameSite=None;Secure;Partitioned` in prod), `resolveSession` (cookie → claims, **re-checks the session row belongs to this workspace+admin**). |
| Mint on load | `src/routes/component.ts:115-139` | Reuses the session across an iframe reload **only if the cookie belongs to this admin+workspace**, else `createSession`. The canonical tenant-isolation gate. |
| New chat | `src/routes/api.ts:1198-1218` | `createSession` + re-cookie. The exact template for the *switch* route. |
| Session store | `src/db/store.ts:546-594` | `createSession` (8h TTL), `getSession` (returns `undefined` once expired). |
| Messages | `src/db/store.ts:596-636` | `addMessage`, `getRecentMessages(sessionId, limit, includePayload)`. |
| History replay | `src/routes/api.ts:1155-1191` | `GET /api/chat/history` — replays stored messages + re-serves the session's live pending previews with rotated nonces. |
| Schema | `src/db/schema.ts:31-49` | `chat_sessions(id, workspace_id, admin_user_id, created_at, last_seen_at, expires_at)`, `chat_messages(... session_id FK ...)`, index `(session_id, created_at)`. |
| UI client | `src/ui/main.ts:63-78, 244-354` | `ChatApi` + `createFetchApi()` — where `listSessions`/`switchSession` get added. |
| UI shell | `src/ui/main.ts:366-389, 522-584` | `mount()` header (where the dropdown goes) + `renderChat`. |
| UI builders | `src/ui/render.ts` | `el()`, `svgIcon()`, the pure DOM-builder pattern the dropdown follows. |

## 3. The hard constraint that shapes everything: the 8-hour session TTL

`src/db/store.ts:117` — `DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000` (8 hours).
`getSession` (`store.ts:585`) returns `undefined` once `expires_at <= now`. The
cookie is independently expiry-checked (`sessions.ts:58`).

**Consequence:** a switcher that works by re-binding the session cookie to a
target session (the cheap, safe mechanism) can only reach **live (≤8h)
sessions**. Conversations older than the session TTL are expired — `getSession`
won't return them and the re-bound cookie would be rejected on the next request.

This produces a genuine fork:

- **Option A — switch among LIVE sessions (THIS plan's scope).** List + switch
  operate on non-expired, owned sessions that have messages. Reuses every
  existing primitive; **no security-posture change**. Limitation: reaches only
  conversations from the current ~8h window (which is the common multi-chat
  workday case, and exactly the "I clicked New chat and want my last one back"
  gap).
- **Option B — full history beyond the session TTL (OUT OF SCOPE).** To reopen
  *yesterday's* chat you must either extend/refresh the session TTL or "revive"
  an expired session on switch. **That directly touches the session-lifetime
  security posture the team has already flagged as a deliberate, human-gated
  decision** — the one audit `wont_fix`, `authz-surface-01` ("the session-TTL /
  per-request-role posture"). An autonomous workflow MUST NOT decide it.

> **Scope ruling:** implement Option A. Document Option B as a future extension
> explicitly gated on the `authz-surface-01` session-TTL decision. The workflow
> and plan 008 must not change `DEFAULT_SESSION_TTL_MS`, the session expiry
> checks, or revive expired sessions.

`chat_messages` age out at `RETENTION_DAYS` (default 90, `store.ts` prune), but
`chat_sessions` rows are **not** pruned — so old session rows persist with no
messages. The list query must therefore filter to **live sessions that have
messages** (skip expired and skip empty just-minted sessions).

## 4. What exists vs. what's missing

**Already present (reuse, don't rebuild):**
- Session creation + cookie minting + the tenant-isolation ownership check
  (`component.ts:122-129`, `deps.ts:64-78`, `api.ts:1198-1217`).
- History replay for the *current* session (`/api/chat/history`).
- The UI's `startNewChat()` (`main.ts:654-668`) — the exact "re-cookie then reset
  the transcript then `restoreHistory()`" shape the switch UI mirrors.
- The pure DOM-builder + `el()`/`svgIcon()` conventions for the dropdown.

**Missing (the work):**
1. **Store**: `listSessions(workspaceId, adminUserId, nowIso)` → live, owned,
   non-empty sessions with a title (first user message), message count, and
   last-activity time, newest first.
2. **Route**: `GET /api/chat/sessions` — session-gated; returns the list, each
   marked `current: row.id === claims.sessionId`.
3. **Route**: `POST /api/chat/sessions/:id/open` — verify the target session is
   owned + live (mirror `resolveSession`/component reuse gate), re-cookie to it
   (mirror `/chat/new`), return `{ ok: true }`.
4. **UI client**: `ChatApi.listSessions()` + `ChatApi.switchSession(id)`.
5. **UI**: a header **"Chats ▾" dropdown** (pure builder in `render.ts`), wired in
   `main.ts` to load on open, switch on select (→ re-cookie → reset transcript →
   `restoreHistory()`), with full keyboard a11y.

## 5. Target data flow

```
Open dropdown
  UI → GET /api/chat/sessions
      route: requireSession → store.listSessions(ws, admin, nowIso)
           → [{ id, title, messageCount, lastMessageAt, current }]  (newest first)
  UI renders the menu (current session marked, e.g. a check)

Select a session (id ≠ current)
  UI → POST /api/chat/sessions/:id/open
      route: requireSession
           → target = store.getSession(id)
           → REJECT (404) unless target && target.workspaceId===claims.workspaceId
                                        && target.adminUserId===claims.adminUserId
           → Set-Cookie: buildSessionCookie(signSessionCookie({sessionId:id, …}, secret), secure)
           → { ok: true }
  UI → reset transcript (like startNewChat) → restoreHistory()  (replays the switched-to session)
```

The switch route is `/chat/new` with `createSession` replaced by
`getSession`+ownership-check, reusing the same cookie machinery byte-for-byte.

## 6. Safety analysis (the part that must be right)

1. **Tenant isolation / IDOR (CRITICAL).** `:id` is attacker-controlled. The
   switch route MUST verify the target session belongs to the **authenticated**
   `claims.workspaceId` AND `claims.adminUserId` before re-cookieing — identical
   to `resolveSession` (`deps.ts:74`) and the component reuse gate
   (`component.ts:123-126`). A foreign/other-admin id returns 404 (not 403 — do
   not confirm existence). `listSessions` is itself scoped by `(workspace_id,
   admin_user_id)` so it can never enumerate another tenant's sessions.
2. **Expiry.** `getSession` already returns `undefined` for expired sessions, so
   switching to an expired id 404s cleanly. The re-cookie carries the **target
   session's** `expiresAt` (never extended) so the security window is unchanged.
3. **No secrets to the model / UI.** The session id is not a secret (it's a
   per-conversation handle, already in the signed cookie), but it must NOT leak
   into model context — and it won't: this is a pure route+UI feature; the
   planner/agent loop never sees session ids. The cookie stays HttpOnly; the UI
   learns session ids only from the authenticated list endpoint.
4. **Pending confirmations are session-scoped.** Switching changes which
   session's live pendings `/chat/history` re-serves (with rotated nonces — the
   existing mechanism). A pending in the previous session stays valid there;
   nothing is cross-bound. No change to the nonce/one-use machinery.
5. **Current-session marking** comes from the route (`claims.sessionId`), never
   from the client — the UI can't spoof "which is current."
6. **Title = first user message** is workspace data (untrusted). The dropdown
   MUST render it via `textContent` (the repo's XSS convention) — never
   `innerHTML`. Truncate for display.
7. **Rate/abuse.** Both endpoints are cheap reads/one cookie write, session-gated,
   no model call — they are NOT behind the chat rate limit (like `/chat/history`
   and `/chat/new`). Fine.

## 7. Open questions — resolved against the code

| Question | Resolution |
|---------|-----------|
| Can the UI know its current session id to highlight it? | No (cookie is HttpOnly). The **route** marks `current` from `claims.sessionId`. |
| Order by? | `last_message_at DESC` (most recent activity first). `last_seen_at` exists but is **never bumped** (`store.ts` has no update), so don't rely on it. |
| Show empty sessions? | No — filter `messageCount > 0`. A just-minted "New chat" with no messages yet shouldn't appear until it has one. |
| What title? | First **user** message content, truncated. If somehow none, fall back to the created-at time. |
| Reopen the CURRENT session? | No-op in the UI (already here) — or simply close the menu. |
| Need a new index? | `chat_sessions` has only `PRIMARY KEY(id)`. Add `idx_chat_sessions_workspace_admin_expires(workspace_id, admin_user_id, expires_at)` for the list seek (matches the repo's index discipline; the per-row title/count subqueries ride the existing `idx_chat_messages_session_created`). |

## 8. Scope boundaries (hard)

**In scope (Option A):** the store method + index, the two routes, the UI client
methods, the dropdown component + wiring + styles + a11y, and tests for each.

**Explicitly OUT of scope:**
- Changing `DEFAULT_SESSION_TTL_MS`, the session expiry checks, or reviving
  expired sessions (Option B — gated on `authz-surface-01`).
- Deleting/renaming conversations (a separate feature; the list is read +
  switch only).
- Cross-workspace or cross-admin visibility (forbidden by design).
- Touching the planner/agent loop/harness (this is route+UI only).
- Server-side session pruning of `chat_sessions` (a separate retention concern).

## 9. Test strategy (what plan 008 pins)

- **Store unit** (`tests/unit/store*.test.ts` pattern): `listSessions` returns
  only live, owned, non-empty sessions, newest-first, with title/count; excludes
  expired, empty, foreign-workspace, and other-admin sessions.
- **Route integration** (`tests/integration/*` + Supertest, fake store/model):
  `GET /chat/sessions` is session-gated, scoped, marks `current`; `POST
  /chat/sessions/:id/open` **404s for a foreign/other-admin/expired id**
  (the IDOR guard — this is the most important test), re-cookies on success, and
  a subsequent `/chat/history` replays the switched-to session.
- **UI unit** (`tests/unit/ui-*.test.ts` pattern): the dropdown builder renders
  titles via `textContent`, marks the current item, fires `switchSession` on
  select, and is keyboard-navigable; `ChatApi.switchSession` POSTs the right path.
- **Live smoke** (optional, in the workflow's final phase): via agent-browser or
  `scripts/repro-chat.ts`, create two conversations, confirm the dropdown lists
  both and switching replays the right transcript.

## 10. Why this is a good autonomous-workflow target

- The mechanism is a **small variation on existing, tested primitives** (cookie
  re-bind = `/chat/new`; ownership check = `resolveSession`), so each phase is
  TDD-able with a clear pass/fail.
- The **one dangerous edge (IDOR) has a single, well-specified guard** and a
  decisive test.
- The **risky temptation (extend the session TTL for "full history") is fenced
  off** by an explicit scope ruling tied to `authz-surface-01`, so an autonomous
  agent can't wander into a security decision.
- It's **route + UI only** — it never touches the safety boundary
  (`src/harness/*`), the money paths, or the model context.
