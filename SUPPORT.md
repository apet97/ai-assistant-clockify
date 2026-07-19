# Support

AI Assistant for Clockify is an admin-only add-on. Use the monitored support route
published on the Marketplace listing for product help, deletion requests, or operational
questions. Supplying and monitoring the support, privacy, and private security routing is
admin package 2 in `MARKETPLACE_READINESS.md`; the add-on must not be submitted before
those routes are live and tested.

## Before opening a request

Record the approximate UTC time, add-on version, browser, Clockify workspace id, action
name, and the sanitized operation id shown in history. State whether the visible result is
success, definitive failure, partial, or unknown. Include a screenshot only after removing
workspace names, people, email addresses, financial data, and unrelated customer content.

Never send a Clockify installation token, personal API key, DeepSeek key, session cookie,
confirmation nonce, CSRF value, encryption key, raw request header, prompt, full model
response, database file, backup, or unredacted operation payload.

## Immediate containment

If the UI reports a partial or unknown write, do not repeat the request. Preserve the
operation id and contact support so the operator can reconcile against authoritative
Clockify state. If a workspace appears at risk, a Clockify owner may deactivate or
uninstall the add-on; uninstall blocks new/queued writes and wipes the persisted token
before already-dispatched work finishes settlement.

## Security and privacy

Suspected vulnerabilities must use the monitored private security route, not a public
issue or ordinary support channel. Privacy and deletion requests use the monitored privacy
route. The final destinations are deliberately not embedded in source control; admin
package 2 owns them and admin package 3 confirms their public URLs.
