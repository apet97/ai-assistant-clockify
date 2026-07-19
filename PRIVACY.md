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
  chat, audit, permissions, sessions, operation results, undo, and artifacts. Startup
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

Version 1.0.0 sends model turns to DeepSeek through the existing OpenAI-compatible
HTTPS integration (`LLM_BASE_URL`). Clockify API calls go only to validated Clockify
service origins using the encrypted installation token. No analytics, advertising, or
other application subprocessors are built into this repository.

The repository cannot prove the operator account's DeepSeek DPA, processing country or
region, provider retention, context-cache retention, or training posture. Those exact
decisions and the final first-run wording are admin package 1 in
`MARKETPLACE_READINESS.md`. The add-on must not be submitted until the published
disclosure matches that approved record.

## Contact

For a data-deletion request or privacy question, use the monitored privacy route
published in the Marketplace listing and on the deployed Support page. Supplying and
monitoring that route is admin package 2 in `MARKETPLACE_READINESS.md`. Never include a
Clockify installation token, provider key, session cookie, confirmation nonce, or raw
header in a request.
