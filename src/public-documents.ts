export type PublicDocumentKind = "privacy" | "terms" | "support" | "security";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const COPY: Record<PublicDocumentKind, { title: string; updated: string; sections: string }> = {
  privacy: {
    title: "Privacy - AI Assistant for Clockify",
    updated: "18 July 2026",
    sections: `
      <h2>Data used by the assistant</h2>
      <p>The add-on sends an administrator's request, a bounded conversation window, permitted action schemas, and the Clockify results needed for that turn to DeepSeek through an OpenAI-compatible HTTPS connection. Exported files are not sent to the model.</p>
      <p>Clockify tokens, add-on tokens, session secrets, confirmation secrets, raw HTTP headers, and the model API key are never sent to the model.</p>
      <h2>Data stored by the add-on</h2>
      <p>Installation credentials are encrypted with AES-256-GCM. Chat and audit records are retained for 90 days by default, operational confirmation and replay records for up to 30 days, eligible undo handles for 30 minutes, and authenticated export files for up to 60 minutes. The operator may configure the chat and audit window, with a 30-day minimum.</p>
      <h2>Deletion</h2>
      <p>Uninstalling immediately blocks new work and removes the stored installation token. Already-dispatched Clockify work is allowed to settle truthfully; the add-on then erases the workspace's stored conversations, permissions, audit data, operation records, undo records, and artifacts. Encrypted backups follow the operator's retention policy.</p>
      <h2>Questions and requests</h2>
      <p>Use the monitored contact below for privacy questions or deletion requests. Never include an API key, token, session cookie, confirmation code, or raw request header.</p>`,
  },
  terms: {
    title: "Terms of Use - AI Assistant for Clockify",
    updated: "19 July 2026",
    sections: `
      <h2>Using the add-on</h2>
      <p>You may use AI Assistant for Clockify only in a workspace where you are an owner or administrator and are authorized to inspect or change the affected data. The add-on is free; a compatible Clockify Pro plan is required.</p>
      <h2>Reviewing actions and outcomes</h2>
      <p>You are responsible for reviewing requests, permission settings, previews, targets, and receipts. Only the on-screen confirmation button authorizes a risky action; typed approval does not. Do not repeat a write whose receipt reports a partial or unknown outcome until the result has been checked in Clockify.</p>
      <p>Undo is available only for eligible recent creations and is a best-effort compensation. It is not a general rollback guarantee. Service rollback does not reverse changes already made in Clockify.</p>
      <h2>AI output and availability</h2>
      <p>Model-generated text may be incomplete or incorrect. Deterministic controls limit which supported actions can execute, but you must still verify important results in Clockify. Availability depends on Clockify, DeepSeek, and the operator's service.</p>
      <h2>Acceptable use</h2>
      <p>Do not use the add-on to violate law, another person's rights, Clockify terms, or workspace policy; probe another workspace; bypass access controls; or submit credentials, secrets, or unnecessary sensitive data in chat.</p>
      <h2>Changes and termination</h2>
      <p>The operator may update these terms with a new effective date or suspend access to protect users, data, or service integrity. You may stop using the add-on at any time by uninstalling it. Data handling and deletion are described in the Privacy notice.</p>`,
  },
  support: {
    title: "Support - AI Assistant for Clockify",
    updated: "18 July 2026",
    sections: `
      <h2>Before contacting support</h2>
      <p>Reload the Clockify add-on, confirm that you are a workspace owner or administrator, and note the time of the issue, the visible receipt status, and whether the operation was a read, preview, confirmation, or undo.</p>
      <h2>What to include</h2>
      <p>Include a short description, browser name, approximate timestamp and the nonsecret action name shown in the receipt. Do not send Clockify or DeepSeek credentials, cookies, confirmation nonces, raw headers, full prompts, or customer exports.</p>
      <h2>Outcome safety</h2>
      <p>If a receipt says partial or outcome unknown, do not repeat the write. Check Clockify first and include the visible receipt state in the support request. Undo is offered only when eligible and is not a guarantee that every Clockify change can be rolled back.</p>`,
  },
  security: {
    title: "Security - AI Assistant for Clockify",
    updated: "18 July 2026",
    sections: `
      <h2>How actions are controlled</h2>
      <p>The model proposes named actions; a deterministic server validates administrator role, saved permissions, declared intent, schema, risk and current installation state. The model cannot call Clockify directly and never receives Clockify credentials.</p>
      <p>Reads return directly. Only explicitly classified safe writes may run immediately. Editing existing data and every risky write require a dry-run preview and a button confirmation. Typing “yes” never confirms a risky operation.</p>
      <h2>Write settlement</h2>
      <p>Every mutation is journaled before dispatch, role and installation state are rechecked, and writes are not automatically retried after dispatch. Receipts distinguish success, partial completion, definitive failure and unknown outcome.</p>
      <h2>Report a vulnerability</h2>
      <p>Use the monitored contact below. Do not include live credentials or customer data. Provide a minimal reproduction and the affected route or action name.</p>`,
  },
};

/** Render a static, script-free public document. All dynamic data is escaped. */
export function renderPublicDocument(kind: PublicDocumentKind, contactUrl?: string): string {
  const copy = COPY[kind];
  const contact = contactUrl
    ? `<a href="${escapeHtml(contactUrl)}" rel="nofollow noreferrer">Contact support, privacy and security</a>`
    : "Use the monitored support, privacy or security destination published in the Marketplace listing.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${copy.title}</title>
<style>body{max-width:760px;margin:0 auto;padding:32px 20px;font:16px/1.6 system-ui,sans-serif;color:#172033;background:#fff}nav{display:flex;gap:18px;flex-wrap:wrap}a{color:#245fdf}h1{line-height:1.2}footer{margin-top:40px;padding-top:20px;border-top:1px solid #d7dce5;color:#4e5b70}</style></head>
    <body><nav aria-label="Public documents"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a><a href="/security">Security</a></nav>
<main><h1>${copy.title.split(" - ")[0]}</h1><p><strong>AI Assistant for Clockify</strong> is available only to workspace owners and administrators.</p>${copy.sections}
<h2>Contact</h2><p>${contact}</p></main>
<footer>Last updated: ${copy.updated}</footer></body></html>`;
}
