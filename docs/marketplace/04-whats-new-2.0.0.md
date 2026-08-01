# What's New - version 2.0.0

This is the paste-ready source for the Marketplace **What's New** version entry. Admin
package 3 reviews it against the exact deployed candidate and pastes it without adding
new product claims. The version 1.0.0 entry
([`04-whats-new-1.0.0.md`](./04-whats-new-1.0.0.md)) is retained unchanged as v1
history; it is not superseded prose, it is the record of a different engine.

## Version

`2.0.0`

## Why a major version

Version 2.0.0 replaces the assistant engine. The planner, the catalog the model can
see, and the runtime that carries a request from question to receipt are all new.

What is unchanged: the add-on is admin-only; a deterministic harness, not the model,
is the only thing that touches Clockify; the model never holds Clockify credentials;
and no risky write reaches Clockify without a dry-run preview and a button
confirmation.

What changed inside that boundary: version 1.0.0 authorized a write by extracting an
admin-authored intent capability from the request text before the write could run.
V2 does not run that declaration pass at all — the button confirmation on an exact,
durable preview is now the whole write authority. Because that is the only authority,
**every** model-originated write is previewed, including the safe writes 1.0.0 executed
immediately.

The major bump makes that v1/v2 boundary legible in the deployed `/version` metadata
and in any rollback conversation.

## Paste-ready release summary

> AI Assistant for Clockify now runs on a rebuilt assistant engine. The assistant
> discovers and loads a bounded set of atomic Clockify API operations for the request
> in front of it, instead of choosing from one large fixed list, and it works from
> 127 reviewed read and write operations.
>
> Every change the assistant proposes is now a dry-run preview that only a button
> confirmation can execute — safe writes included. Reads still return directly.
> Typing "yes" still never confirms anything.
>
> Results are presented from the recorded outcome rather than from the assistant's
> own words, so a receipt cannot describe a change that did not happen. A request
> that was already satisfied now reports **No change needed** instead of an
> ambiguous success, alongside succeeded, partial, failed, cancelled, awaiting
> confirmation, and unknown-outcome states.
>
> Unchanged: the add-on is admin-only, each administrator controls only their own
> per-workspace permission policy, the model never receives Clockify credentials and
> cannot execute an action itself, Undo remains available only for eligible recent
> creations, and conversation history, accessible light and dark themes, and
> authenticated short-lived PDF downloads all work as before.
>
> English interface; Unicode workspace data; timezone-aware Intl formatting. The
> release uses DeepSeek through the documented OpenAI-compatible provider boundary.

## Portal check

- Version is exactly `2.0.0`, and matches `package.json` and the deployed `/version`
  response.
- The release summary is pasted as one version entry, not appended to the long listing
  description.
- The provider sentence matches the final admin package 1 disclosure decision.
- The entry does not claim universal rollback, blanket exactly-once execution, or that a
  partial or unknown outcome succeeded.
- The entry states no performance figure, no evaluation result, and no Marketplace
  status. None of those exist for this engine yet.
- The "safe writes are previewed too" sentence is a behavior change from version 1.0.0
  and must not be dropped when shortening.
