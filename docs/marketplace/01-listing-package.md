# Marketplace listing package - version 2.0.0

This file is the paste-ready listing source and asset manifest. Engineering produces
and verifies every referenced asset. Admin package 3 supplies the final production base
URL, confirms the portal fields, uploads the prepared files, and later clicks **Submit
for Review**.

Every product claim below describes the **v2 engine** — the engine `ASSISTANT_ENGINE`
selects by default and the one production serves. Where v2 behaves differently from
version 1.0.0, this file states the v2 behavior; the v1 wording is preserved only in
[`04-whats-new-1.0.0.md`](./04-whats-new-1.0.0.md) and the v1 evidence record.

## Portal field map

| Field | Final value |
|---|---|
| Name | AI Assistant for Clockify |
| Version | 2.0.0 |
| Tagline | Ask. Preview. Confirm. |
| Short description | Admin-only AI assistant for controlled Clockify workspace operations. |
| Intended users | Clockify workspace owners and administrators |
| Pricing | Free add-on; Clockify Pro required |
| Plan requirement | Clockify Pro, as declared by manifest 1.5 |
| Category | Productivity or the closest available time-management category; admin package 3 confirms the portal taxonomy |
| Website | Admin package 3: the deployed production base URL |
| Support URL | Admin package 3: the deployed production base URL plus `/support` |
| Privacy URL | Admin package 3: the deployed production base URL plus `/privacy` |
| Security URL | Admin package 3: the deployed production base URL plus `/security` |
| Terms URL | Admin package 3: the deployed production base URL plus `/terms` |
| Support and privacy contact | Admin package 2: the monitored routing destination |

The four document paths above are deferred to admin package 3 only for the **base
URL**, not for the routes: `/privacy`, `/terms`, `/support`, and `/security` are all
served today as script-free public pages. Admin package 3 prefixes them with the
confirmed production origin and pastes the result.

## Full description

> Turn plain-language admin requests into controlled Clockify operations.
>
> AI Assistant for Clockify gives workspace owners and administrators one place to
> inspect workspace data, prepare changes, and carry out supported administrative work.
> Ask for a report, a workspace lookup, or an operational change in natural language;
> the assistant loads what that request needs from a fixed, reviewed catalog of
> 127 typed Clockify API actions.
>
> The model does not receive Clockify credentials and cannot execute an action itself.
> A deterministic backend verifies the administrator role, their saved
> permission policy, the action schema, and the operation's
> risk before executing the requested Clockify action.
>
> Reads return directly. Every change the assistant proposes produces a dry-run
> preview and executes only after a button confirmation - low-risk ones included.
> Typing "yes" never confirms an operation.
>
> Receipts are built from the recorded outcome and preserve successful, no-change,
> partial, failed, and unknown states. Exact request
> replay returns the durable result. Undo is offered only
> for eligible recent creations and is best-effort compensation, not a promise to roll
> back every Clockify change.
>
> Each administrator controls only their own per-workspace permission policy. The add-on
> includes accessible light and dark themes, conversation history, and authenticated
> short-lived PDF downloads where supported.
>
> English interface; Unicode workspace data; timezone-aware Intl formatting.

## Privacy disclosure copy

The release uses DeepSeek through the existing OpenAI-compatible HTTPS integration.
Admin-authored requests, a bounded conversation window, permitted action schemas, and
the Clockify results needed for the turn may be sent to DeepSeek. Clockify tokens,
session secrets, confirmation secrets, raw headers, and the model API key are never sent
to the model. Local retention and deletion behavior is documented on the Privacy page.
The final DPA, processing location, provider retention, context-cache retention, and
training wording is the decision record in admin package 1 and must match the first-run
disclosure before portal submission.

## Scope statement

The manifest's scope list is generated from
[`../ENDPOINT_SCOPE_CONTRACT.md`](../ENDPOINT_SCOPE_CONTRACT.md). Every retained scope
has an adapter endpoint family and an offline probe. Reports use `REPORTS_READ` only;
`REPORTS_WRITE` is not declared. The portal scope list must match the manifest served by
the exact deployed source-candidate commit.

## Asset inventory

| Purpose | Source of record | Delivery file | Required content check |
|---|---|---|---|
| App icon | `assets/icon.svg` | `assets/icon.png` - 512 x 512 RGBA | Legible at sidebar size; no text or transparency defect |
| Listing banner | `assets/banner.svg` | `assets/banner.png` - 1600 x 900 RGBA | Product name, tagline, admin-only positioning, no customer data |
| First-run disclosure | Reproducible release-build capture | `assets/screenshots/01-first-run-permissions.png` | DeepSeek disclosure, permission policy, persistent legal/support links |
| Read and receipt | Reproducible release-build capture | `assets/screenshots/02-read-and-receipt.png` | Sanitized read result and complete receipt state |
| Risky preview | Reproducible release-build capture | `assets/screenshots/03-risky-preview-confirm.png` | Preview and button-only Confirm/Cancel controls |
| Receipt and undo | Reproducible release-build capture | `assets/screenshots/04-receipt-and-undo.png` | Successful receipt and truthful completed Undo state |
| History and artifact | Reproducible release-build capture | `assets/screenshots/05-history-and-pdf-download.png` | Restored history and authenticated Download PDF action |
| Demo video | Reproducible release-build recording | `assets/video/ai-assistant-2.0.0-demo.mp4` | Script below, readable UI, no secrets or customer data |
| Asset evidence | Generated by `npm run media:marketplace` | `assets/asset-evidence.json` | Capture-source hash, exact asset hashes and dimensions, storyboard, and required visual-review artifact |
| Engineering visual review | Generated pending, completed only after inspection | `assets/media-engineering-review.json` | Exact capture-source and asset-set hashes, named checks, reviewer, timestamp, and honest pending/passed status |

The checked-in asset evidence includes the capture-source hash, file hashes, and
dimensions/duration. The generator always resets the separate engineering visual review
artifact to `pending`; generating files never claims they were inspected. Only a reviewer
who opened every asset at original size may mark its five checks and overall status
`passed`, and only when its capture-source and asset-set hashes match. A file path is not
proof that the file exists or passed review.

The checked-in files deliberately do not record their own final commit or archive hash;
that would be self-referential. After commit, CI and the release-evidence workflow run
`npm run evidence:marketplace-media-binding`. Its immutable post-commit workflow artifact
hashes the checked-in evidence and review, validates the current capture source and asset
bytes, and binds them to the tested/deployed source-candidate SHA and archive hash. The
workflow records `github.sha` separately as the evidence commit and permits a different
PR head only when the candidate is its ancestor and every intervening path is allowlisted
non-executable release evidence.

## Screenshot and demo capture rules

- Generate the delivery assets from the exact clean source with the checked-in,
  workspace-free deterministic synthetic fixture (`npm run media:marketplace`). It
  recreates the five screenshots, the complete seven-step video, icon/banner PNGs, and
  `asset-evidence.json` in one command.
- `asset-evidence.json` binds the captures to a SHA-256 of the built UI, SVG sources,
  fixture, generator, and shared hashing contract. A repeat run may retain prior bytes
  only when that source hash
  is unchanged and the newly rendered PNG/video is within the recorded one-channel,
  SSIM, and PSNR anti-aliasing tolerances; a material source or visual change is always
  regenerated.
- Keep the separate live-browser release evidence tied to the exact deployed commit.
  Fixture media is listing material, not proof of provider or Clockify connectivity.
- The checked-in media set and the generator's step-3 storyboard label
  (`scripts/generate-marketplace-media.ts`, "Safe write and immediate receipt") still
  model version 1.0.0's immediate-safe-write semantics. The v2 engine previews that
  case, so the regenerated set must show a preview and confirmation there; the
  fixture, the storyboard label, and its pinned assertion move together.
- Hide browser chrome, workspace identifiers, account email, tokens, operation secrets,
  and unrelated customer data.
- Do not edit a receipt to imply success. Preserve partial, failed, or unknown labels if
  that is the demonstrated state.
- English interface; Unicode workspace data; timezone-aware Intl formatting.
- Keep interactive labels and model disclosure readable after portal compression.

## Demo script

1. Open the add-on as an owner or administrator and show the first-run DeepSeek and data
   disclosure, the saved permission policy, and Privacy/Support/Security links.
2. Ask a read-only workspace question and show its receipt.
3. Ask for one low-risk change, show that it is previewed rather than executed, and
   confirm it with the button. In v2 the assistant previews every write it proposes;
   do not record or narrate a safe write as executing immediately.
4. Ask for a risky edit, inspect the dry-run preview, and use the Confirm button.
5. Show the confirmed receipt and, for an eligible action, the Undo affordance and its
   truthful result. Do not imply that an existing-data edit has automatic Undo.
6. Open history, reload the iframe, restore the same conversation, and download a
   short-lived PDF artifact.
7. End on the permission controls and state that members cannot open the assistant.

The deterministic fixture never contacts Clockify and creates no external resources.
Cleanup evidence applies to the separate live-browser flow, not to this listing video.

## Portal-only completion - admin package 3

- Confirm version 2.0.0 in package/portal metadata and the deployed `/version` release
  metadata. Confirm that the live manifest reports the production base URL, admin-only
  sidebar component, verified icon, and generated scopes; manifest 1.5 has no add-on
  version field.
- Confirm the production Support, Privacy, Security, Terms, and Website URLs.
- Confirm the final pricing value is **Free add-on; Clockify Pro required** and paste the
  prepared [`What's New`](./04-whats-new-2.0.0.md) version entry. The
  [1.0.0 entry](./04-whats-new-1.0.0.md) is retained v1 history and must not be pasted.
- Review the final copy against the deployed UI and the admin package 1 disclosure.
- Upload the supplied icon, banner, five screenshots, and demo video.
- Preview the listing at desktop and narrow portal widths.
- Leave **Submit for Review** untouched until admin packages 1 and 2 are signed.
