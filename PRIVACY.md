# Privacy & Data Handling

The AI Assistant for Clockify is an **admin-only** embedded chat. Only Clockify
workspace **admins/owners** can use it; everyone else is rejected before a session
is created. This document describes what the add-on stores, for how long, and how
to have it deleted. It reflects the behavior in this repository (see `src/db/` and
`src/harness/` for the enforcement).

The interface and data-handling criterion is: **English interface; Unicode workspace
data; timezone-aware Intl formatting**.

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
headers, and tokens are excluded from production provider-error logs. That is the
narrowest of several log sinks; **Server operational logs** below states what every
other one contains.

## What is stored, and for how long

All data lives in a single SQLite database on the server (a persistent Railway
`/data` volume in the reference deployment). Every admin-scoped row is keyed by
workspace + admin, and is isolated per workspace.

| Data | Purpose | Retention |
|---|---|---|
| Installation token + lifecycle issuer watermark | Authenticate Clockify API calls; reject older signed lifecycle deliveries for prior generations | Token remains only while installed and is **wiped immediately when uninstall starts**. Stored **AES-256-GCM encrypted** at rest. The exact nonsecret JWT `iat` remains with the install row while that row exists |
| Fresh-install release attestation | Prove that the exact deployed release and manifest received a genuine fresh Clockify install before production scope/AUDIT testing. Stores only a workspace hash, token fingerprint hash, generation, release/artifact hashes, timestamp, and source relationship | One uninterrupted active installation generation. Invalidated on token replacement/status churn and deleted immediately on uninstall |
| Retired-token anti-replay fingerprint | Prevent a delayed, previously valid lifecycle callback from restoring an old installation token after replacement or uninstall | One fixed 32-byte, domain-separated SHA-256 digest per retired high-entropy token. It has no workspace/user identifier and uses a domain distinct from the active attestation fingerprint. Retained because the platform lifecycle claim has no trusted ordered event id; expiring it would reopen token resurrection |
| Lifecycle authority lineage | Prevent a delayed, never-before-persisted lifecycle token from recreating an inactive/deleted installation after its workspace row was erased | One separate-domain SHA-256 workspace fingerprint plus issuer `iat`, active/inactive/deleted state, generation, and timestamps. No raw workspace, token, or user id. Pruned after **24 hours + 2 minutes + 1 second**, when every lifecycle JWT that could precede the recorded authority is necessarily outside the inclusive integer-second age/skew window |
| Admin permissions | Per-admin action policy | While installed; deleted on uninstall |
| Chat transcripts | Conversation history + session restore | **90 days** (configurable, min 30) |
| Audit log | Every action + its outcome (accountability, recaps) | **90 days** (configurable, min 30) |
| Pending confirmations | Risky-write previews awaiting button-confirm | 30 days |
| Undo records | Reverse a recent creation | **30 minutes to use**; terminal metadata retained up to 30 days |
| Turn telemetry | Model call counts / token usage / latency (cost) | 30 days |
| Durable safety/replay state | Canonical action outcomes, immutable intent capabilities and bindings, retry replay, normalized nonsecret mutation plans, authoritative target snapshots, step reconciliation, and truthful history | 30–90 days, depending on whether the row is operational metadata or a canonical result |
| Agent run records (`assistant_runs`) | The v2 agent's per-request working record: a verbatim copy of the admin's chat message (capped at 16,000 bytes), the run phase, the request and catalog hashes, the loaded and used action names, the bounded model continuation, and the budget/unfinished-operation state | **90 days**, the same `RETENTION_DAYS` chat/audit window (configurable, min 30), swept on `updated_at` |
| Agent run event journal (`run_events`) | An ordered per-run diagnostic journal (run, model, discovery, tool, operation, clarification and terminal events). Every payload is a closed `.strict()` schema of ids, 64-character hex hashes, counters, action names, token counts, latency and error codes, capped at 65,536 bytes; it never carries admin-authored text or Clockify business data | No independent sweep — these rows are removed only by the `ON DELETE CASCADE` from their `assistant_runs` row, so they live exactly as long as that run record and no longer: **90 days** by default |
| Grounded entity references (`entity_references`) | Let a follow-up request keep referring to the same Clockify thing. Stores the entity type, the Clockify id, the display name (a real workspace entity name), bounded nonsecret bindings and a binding fingerprint. The reference feature is dormant in the shipped engine by owner decision; the table and its erasure path remain | **90 days**, the same `RETENTION_DAYS` chat/audit window, swept on `updated_at`, and also removed by the `assistant_runs` cascade |
| Pending clarifications (`pending_clarifications`) | A question the assistant asked before acting, with the model's partial arguments and the grounded candidate options offered to the admin. Both JSON columns are bounded at 16,384 bytes and can contain Clockify entity names and ids | Answerable for **5 minutes**; an unanswered row is then marked expired and its partial arguments and candidate list are scrubbed. Terminal rows (`resolved`, `continued`, `expired`, `cancelled`) are deleted **30 days** after creation. A row abandoned mid-selection (`resolving`) matches neither sweep and is removed by the `assistant_runs` cascade at the 90-day window |
| Export artifacts | Authenticated invoice/report download | 60 minutes; hard limit 1,000,000 bytes |
| Session records | Signed session cookie state (validity `SESSION_TTL_HOURS`, default 2h) | Pruned only after expired dependent data is gone |

Retention is enforced at startup and hourly in 500-row transactions. Each pass is
capped at 10,000 deleted rows, yields between batches, and schedules an immediate
continuation when backlog remains. Expired sessions/previews/artifacts are treated as
gone on read even before physical deletion. The chat/audit
window is set by the `RETENTION_DAYS` environment variable (default **90**, minimum
**30** so the 30-day metrics view is never truncated). Uninstall is not deferred to the
hourly schedule: it immediately blocks work and wipes the token, then erases the workspace
after already-dispatched mutation settlement drains. Each retention pass persists only
operational evidence (deleted/expired/backlog counts, duration, and passive-WAL checkpoint
status), not an extra copy of customer content.

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

## Server operational logs

Logs are a **separate sink** from the database above. They are written to the hosting
platform's log stream, not to SQLite, so they are governed by that platform's retention
rather than by `RETENTION_DAYS`, and they survive an uninstall erasure. That is why what
may enter them is constrained at the source.

A caught error is not safe to print. A malformed request body reaches the error object
*through its message* — the JSON parser quotes the offending bytes verbatim, so a
mistyped chat request can put a fragment of the admin's own sentence, a workspace id, or
a token prefix into the message. A schema-validation error likewise echoes the rejected
value and the submitted field names. Accordingly, **no server log line — request-error,
background-task, or crash — carries the caught value's message text**, stack, or captured
payload. Each carries a bounded classification: the error's type name plus its driver,
HTTP, or parser code — for example
`request error: name=SyntaxError type=entity.parse.failed status=400`. A field that does
not already look like such a code is reported as `unclassified` rather than printed
(`src/log-error-class.ts`, pinned by `tests/unit/error-log-privacy-contract.test.ts`).
The HTTP response returned to the caller carries even less: a fixed sentence and the
status code, never the error.

Every other operator line is built from fixed vocabulary, counts, bounded identifiers,
and hashed aliases — workspace and add-on ids appear as HMAC aliases rather than raw ids.
The one value on any alert line that a third party controls is the model provider's
correlation id, and it is bounded to an identifier shape at the source
(`src/assistant/model-client.ts`) rather than trusted. Two limits are stated rather than
implied:

- Clockify request paths, which contain workspace and entity ids, do appear in the
  list-pagination backstop warning emitted by the REST adapter (`src/clockify/rest/`).
  That line is not an error log and carries no response body.
- Durable operation rows — in the database, not the log — retain the failure message
  itself, because reconciling an uncertain write requires knowing how it failed. For a
  failed Clockify call that message is built by this add-on and is bounded by
  construction — the method, the request path, the HTTP status, and at most 200 bytes of
  the response body — but it is **not** redacted: the path carries workspace and entity
  ids, and those 200 bytes are host data. What protects it is that it is stored, never
  logged; it follows the retention table above and is erased on uninstall.

Prompts, tool results, request headers, cookies, installation tokens, confirmation
nonces, and model API keys are never written to any log.

## Encryption

Installation tokens are encrypted at rest with **AES-256-GCM**. The key is derived
(SHA-256) from the operator-supplied `DATA_ENCRYPTION_KEY` passphrase
(`src/db/encryption.ts`). A one-release `DATA_ENCRYPTION_KEY_PREVIOUS` fallback
transactionally re-encrypts existing installation tokens during key rotation. No
other stored field is treated as an authentication secret.

The release attestation never stores a second token copy. Its token fingerprint is
a domain-separated SHA-256 digest used only to match the authenticated retrieval
request to the current installation generation. A domain-separated HMAC derived from
`SESSION_SECRET` signs the secret-free verification envelope; the public verifier
returns release/artifact bindings only, never the workspace hash or installation data.
When a token is replaced or uninstall begins, a second-domain SHA-256 fingerprint is
inserted into a global anti-replay set before the encrypted token is wiped. That set
contains no workspace/user id and cannot be joined to the active-attestation digest.
It is deliberately not time-pruned: lifecycle claims expose no trusted event sequence,
so deleting a fingerprint would let a freshly redelivered old callback restore authority.
That token set covers callbacks whose outgoing token was observed. A second,
domain-separated workspace fingerprint records the highest accepted lifecycle issuer
time, revocation state, and generation, so a never-before-seen older token cannot recreate
authority after row erasure. It is bounded to 24 hours + 2 minutes + 1 second because the lifecycle
route rejects older JWTs; `DELETED` outranks `INACTIVE`, which outranks `ACTIVE`, when
whole-second issuer times tie.

## Deletion & your rights

- **Uninstall** the add-on from Clockify: `POST /lifecycle/deleted` immediately makes the
  installation inactive, wipes its encrypted token, rejects new and queued writes, and
  records a deletion tombstone. A Clockify mutation that was already dispatched is
  allowed to settle truthfully without access to the wiped persisted token. After the
  settlement barrier drains, the handler hard-deletes the workspace's installation,
  chat, audit, permissions, sessions, agent run records (`assistant_runs` and its
  cascaded `run_events`), grounded entity references, pending clarifications,
  operation results, undo, and artifacts. Startup
  completes an interrupted deletion tombstone before accepting work for that workspace.
  The workspace-unlinked retired-token digest remains solely as a replay-denial value.
  The separate lifecycle-lineage workspace fingerprint remains for at most 24 hours +
  2 minutes + 1 second. Neither record contains a raw token or user id; the lineage contains no raw
  workspace id.
- **On request**, an operator can erase a single workspace at any time with
  `scripts/erase-workspace.ts` (offline, double-gated), which performs the same
  full erasure.
- Self-hosters can also delete the SQLite file at `DATABASE_PATH`.

Backups are operator-controlled copies and are not removed by the application's hourly
sweep or uninstall handler. Operators must keep them encrypted and off-volume and delete
them no later than the source-data retention policy permits; see `DEPLOYMENT.md`.

## Sub-processors

Version 2.0.0 sends model turns to exactly one model provider: the OpenAI-compatible HTTPS
endpoint the operator configures in `LLM_BASE_URL`, using the model named in `LLM_MODEL`.
Neither value has a default in this repository — `LLM_PROVIDER` defaults to `http`, and
configuration then fails to load unless the operator supplies the endpoint, key, and model
— so the repository pins the *integration*, not the vendor. **The reference deployment, the
admin-facing first-run disclosure (`src/ui/product.ts`), and the Marketplace listing all
name DeepSeek, and DeepSeek is the provider an installing workspace should expect.**
Version 1.0.0 pinned a specific DeepSeek model and thinking mode through a released binding
record; version 2.0.0 has no released model configuration yet, so the deployed-engine
evidence deliberately declines to attest a model setting rather than fabricate one. An
operator who repoints `LLM_BASE_URL` at a different provider changes the sub-processor and
must republish this disclosure before installing for anyone else. Clockify API calls go
only to validated Clockify service origins using the encrypted installation token. No
analytics, advertising, or other application subprocessors are built into this repository.

The repository cannot prove the operator account's provider DPA, processing country or
region, provider retention, context-cache retention, or training posture. Those exact
decisions, the v2 model configuration itself, and the final first-run wording are admin
package 1 in `MARKETPLACE_READINESS.md`. The add-on must not be submitted until the
published disclosure matches that approved record.

## Contact

For a data-deletion request or privacy question, use the monitored privacy route
published in the Marketplace listing and on the deployed Support page. Supplying and
monitoring that route is admin package 2 in `MARKETPLACE_READINESS.md`. Never include a
Clockify installation token, provider key, session cookie, confirmation nonce, or raw
header in a request.
