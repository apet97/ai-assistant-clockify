# Privacy & Data Handling

The AI Assistant for Clockify is an **admin-only** embedded chat. Only Clockify
workspace **admins/owners** can use it; everyone else is rejected before a session
is created. This document describes what the add-on stores, for how long, and how
to have it deleted. It reflects the behavior in this repository (see `src/db/` and
`src/harness/` for the enforcement).

## What the model sees — and never sees

The language model is treated as **untrusted**: it proposes actions, a
deterministic harness validates and executes them. The model receives only the
action catalog, the admin's current permissions, and a short window of recent chat
messages. The model **never** receives Clockify tokens, the add-on token, session
secrets, the model API key, or raw HTTP headers. Entity names/ids are resolved
server-side. Nothing secret is ever logged.

## What is stored, and for how long

All data lives in a single SQLite database on the server (a persistent Railway
`/data` volume in the reference deployment). Every admin-scoped row is keyed by
workspace + admin, and is isolated per workspace.

| Data | Purpose | Retention |
|---|---|---|
| Installation token | Authenticate Clockify API calls | While installed; **wiped on uninstall**. Stored **AES-256-GCM encrypted** at rest |
| Admin permissions | Per-admin action policy | While installed; deleted on uninstall |
| Chat transcripts | Conversation history + session restore | **90 days** (configurable, min 30) |
| Audit log | Every action + its outcome (accountability, recaps) | **90 days** (configurable, min 30) |
| Pending confirmations | Risky-write previews awaiting button-confirm | 30 days |
| Undo records | Reverse a recent creation | 30 days |
| Turn telemetry | Model call counts / token usage / latency (cost) | 30 days |
| Session records | Signed session cookie state (validity `SESSION_TTL_HOURS`, default 2h) | Deleted on uninstall |

Retention is enforced by an hourly background sweep, so a row may persist for **up to
~1 hour past** its window before deletion (and expired sessions/previews are already
treated as gone before then — they're filtered by their expiry on read). The chat/audit
window is set by the `RETENTION_DAYS` environment variable (default **90**, minimum
**30** so the 30-day metrics view is never truncated). Uninstall erasure (below) is
**immediate**, not on the hourly schedule.

## Encryption

Installation tokens are encrypted at rest with **AES-256-GCM**. The key is derived
(SHA-256) from the operator-supplied `DATA_ENCRYPTION_KEY` passphrase
(`src/db/encryption.ts`). No other field is secret.

## Deletion & your rights

- **Uninstall** the add-on from Clockify: `POST /lifecycle/deleted` **immediately
  erases all of that workspace's data** — chat transcripts, audit log, permissions,
  sessions, and operational rows — and wipes the stored token (a `deleted`
  tombstone row remains).
- **On request**, an operator can erase a single workspace at any time with
  `scripts/erase-workspace.ts` (offline, double-gated), which performs the same
  full erasure.
- Self-hosters can also delete the SQLite file at `DATABASE_PATH`.

## Sub-processors

Chat turns are sent to the configured model endpoint (`LLM_BASE_URL`) — with **no
secrets** — for the assistant to function. Clockify API calls go to the workspace's
Clockify hosts using the encrypted installation token. No other third parties
receive data.

## Contact

For a data-deletion request or privacy question, contact the add-on operator
(the workspace where this add-on is self-hosted). See `README.md` "Security" and
`DEPLOYMENT.md` for operational details.
