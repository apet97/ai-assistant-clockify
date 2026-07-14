# Privacy & Data Handling

The AI Assistant for Clockify is an **admin-only** embedded chat. Only Clockify
workspace **admins/owners** can use it; everyone else is rejected before a session
is created. This document describes what the add-on stores, for how long, and how
to have it deleted. It reflects the behavior in this repository (see `src/db/` and
`src/harness/` for the enforcement).

## What the model sees — and never sees

The language model is treated as **untrusted**: it proposes actions, while a
deterministic harness validates and executes them. The model receives the
admin-authored request, a bounded recent conversation window, the permitted action
schemas, and the tool results needed to continue that turn. Tool results can contain
Clockify business data such as entity names and ids, descriptions, dates/times,
amounts, statuses, user display names, and summarized error/receipt data. Exported
binaries are never sent to the model; they are stored once as short-lived artifacts.
Before the main planner can receive Clockify results, a constrained declaration call
sees only the current and unresolved prior admin-authored text plus trusted action/catalog
metadata; it cannot inspect Clockify tool output.

The model **never** receives Clockify tokens, the add-on token, session secrets, the
model API key, raw HTTP headers, confirmation nonce hashes, or stored encrypted
credentials. Provider error bodies are not logged. Prompts, tool-result bodies,
headers, and tokens are excluded from production provider-error logs.

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
| Undo records | Reverse a recent creation | **30 minutes to use**; terminal metadata retained up to 30 days |
| Turn telemetry | Model call counts / token usage / latency (cost) | 30 days |
| Durable safety/replay state | Canonical action outcomes, immutable intent capabilities and bindings, retry replay, normalized nonsecret mutation plans, authoritative target snapshots, step reconciliation, and truthful history | 30–90 days, depending on whether the row is operational metadata or a canonical result |
| Export artifacts | Authenticated invoice/report download | 60 minutes; hard limit 1,000,000 bytes |
| Session records | Signed session cookie state (validity `SESSION_TTL_HOURS`, default 2h) | Pruned only after expired dependent data is gone |

Retention is enforced at startup and hourly in 500-row transactions. Each pass is
capped at 10,000 deleted rows, yields between batches, and schedules an immediate
continuation when backlog remains. Expired sessions/previews/artifacts are treated as
gone on read even before physical deletion. The chat/audit
window is set by the `RETENTION_DAYS` environment variable (default **90**, minimum
**30** so the 30-day metrics view is never truncated). Uninstall erasure (below) is
**immediate**, not on the hourly schedule. Each retention pass persists only operational
evidence (deleted/expired/backlog counts, duration, and passive-WAL checkpoint status),
not an extra copy of customer content.

Full action outcomes are stored once in the canonical `action_results` table.
Turn replay, chat history, audit, confirmation, undo, operation-journal, and
idempotency rows store ordered references plus summaries capped at 65,536 bytes.
Persisted intent capabilities constrain write authority, while durable mutation rows may
contain the nonsecret entity ids/names, dates, amounts, target snapshots, and exact steps
needed to prevent duplicate or misdirected writes and reconcile uncertain outcomes.
Plaintext confirmation nonces are never stored in replay/history envelopes. When a
confirmation is cancelled, expires, settles, or is recovered after a restart, its nonce
hash, saved agent state, and executable operation payload are erased; canonical receipts
and bounded audit/recovery evidence remain until their applicable retention window ends.

## Encryption

Installation tokens are encrypted at rest with **AES-256-GCM**. The key is derived
(SHA-256) from the operator-supplied `DATA_ENCRYPTION_KEY` passphrase
(`src/db/encryption.ts`). A one-release `DATA_ENCRYPTION_KEY_PREVIOUS` fallback
transactionally re-encrypts existing installation tokens during key rotation. No
other stored field is treated as an authentication secret.

## Deletion & your rights

- **Uninstall** the add-on from Clockify: `POST /lifecycle/deleted` **immediately
  hard-deletes all of that workspace's data** — including the installation row and
  encrypted token, chat, audit, permissions, sessions, operation results, undo, and
  artifacts.
- **On request**, an operator can erase a single workspace at any time with
  `scripts/erase-workspace.ts` (offline, double-gated), which performs the same
  full erasure.
- Self-hosters can also delete the SQLite file at `DATABASE_PATH`.

Backups are operator-controlled copies and are not removed by the application's hourly
sweep or uninstall handler. Operators must keep them encrypted and off-volume and delete
them no later than the source-data retention policy permits; see `DEPLOYMENT.md`.

## Sub-processors

Chat turns are sent to the operator-configured model endpoint (`LLM_BASE_URL`) for
the assistant to function. Clockify API calls go only to validated Clockify service
origins using the encrypted installation token. No other application subprocessors
are built into this repository.

The repository cannot determine the configured model provider's retention period,
processing region, or training posture. Marketplace launch therefore remains blocked
until the operator records the provider, DPA/subprocessor terms, selected region,
retention/zero-retention setting, and training opt-out status in
`MARKETPLACE_READINESS.md` with evidence.

## Contact

For a data-deletion request or privacy question, contact the add-on operator
(the workspace where this add-on is self-hosted). See `README.md` "Security" and
`DEPLOYMENT.md` for operational details.
