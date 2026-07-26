import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import {
  defaultAdminPolicy,
  FEATURE_GROUPS,
} from "../../../dist/server/harness/permissions.js";

const port = Number(process.env.E2E_PORT ?? 4174);
const uiRoot = join(process.cwd(), "dist", "ui");
const sessions = new Map();
const expiresAt = "2099-01-01T00:05:00.000Z";
const unicodeWorkspaceData = "Čukarica 東京 — račun № 7";

// Derive browser/media policy fixtures from the built production vocabulary so a
// newly-added group cannot silently disappear from onboarding screenshots or E2E.
const fullPolicy = defaultAdminPolicy();

const restrictedPolicy = {
  version: fullPolicy.version,
  groups: Object.fromEntries(
    FEATURE_GROUPS.map((group) => [group, group === "reports" ? "read" : "off"]),
  ),
};

function cookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)]),
  );
}

function stateFor(request) {
  const sessionId = cookies(request).e2e_session;
  return sessionId ? sessions.get(sessionId) : undefined;
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function ndjson(response, events) {
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

async function body(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function receipt(action, message, extra = {}) {
  return { kind: "receipt", receipt: { ok: true, action, message, ...extra } };
}

function deniedReceipt(action) {
  return {
    kind: "receipt",
    receipt: {
      ok: false,
      action,
      code: "policy_denied",
      message: "Your saved permission policy does not allow this action.",
    },
  };
}

const fixtureActionPolicy = {
  read: { action: "clockify_reports_summary", group: "reports", required: "read" },
  safe: { action: "clockify_start_timer", group: "time_tracking", required: "read_write" },
  "risky-confirm": { action: "clockify_projects_update", group: "work_structure", required: "read_write" },
  "risky-cancel": { action: "clockify_projects_update", group: "work_structure", required: "read_write" },
  batch: { action: "clockify_projects_update", group: "work_structure", required: "read_write" },
  pdf: { action: "clockify_invoices_export", group: "invoices", required: "read" },
  unicode: { action: "clockify_reports_summary", group: "reports", required: "read" },
};

function policyAllows(policy, requirement) {
  const actual = policy.groups[requirement.group] ?? "off";
  return requirement.required === "read"
    ? actual === "read" || actual === "read_write"
    : actual === "read_write";
}

function preview(previewId, actionLabel, expectedChanges) {
  return {
    kind: "preview",
    previewId,
    nonce: `nonce-${previewId}`,
    expiresAt,
    preview: {
      actionLabel,
      expectedChanges,
      reversibility: "No automatic undo; edit the project again to restore prior values.",
      warnings: [],
      riskLabels: ["edits_existing_data"],
      targets: [{ type: "project", id: "project-1", name: "Website launch" }],
    },
  };
}

function remember(state, message, results, reply) {
  state.messages.push({ role: "user", content: message });
  state.messages.push({ role: "assistant", content: reply, results });
}

/**
 * T15-E: a run_event frame carrying a structured `PresentedResult` envelope —
 * the same wire shape a real v2 run would stream, but fabricated directly by
 * this fixture. Production's own `chatResultToPresentation` doesn't yet
 * populate facts/references/recovery for any real domain (flagged for the
 * T14-T16 review gate), so this is how the render layer gets real coverage of
 * the full envelope without wiring server-side production code — exactly what
 * this fixture exists for (T15-E's own modify list names it explicitly).
 */
let structuredSequence = 0;
function structuredRunEvent(runId, presentation, extra = {}) {
  structuredSequence += 1;
  const kind = presentation.status === "pending_confirmation" ? "pending_confirmation" : "presented_result";
  const envelope = {
    presentation,
    ...(kind === "presented_result" ? { diagnostic: { kind: "sanitized_receipt", byteLength: 2, value: { ok: true } } } : {}),
    ...(kind === "pending_confirmation" ? { confirmation: { id: "structured-1", nonce: "structured-nonce-1", expiresAt } } : {}),
  };
  return {
    type: "run_event",
    runId,
    sequence: structuredSequence,
    event: { eventType: kind === "pending_confirmation" ? "operation.prepared" : "tool.completed", payload: {}, createdAt: "2026-07-18T10:00:00.000Z" },
    attachment: kind === "presented_result"
      ? { kind, actionResultId: "structured-result-1", envelope }
      : { kind, confirmationId: "structured-1", envelope },
    ...extra,
  };
}

const STRUCTURED_PRESENTATIONS = {
  "structured-succeeded": {
    status: "succeeded",
    title: "Create a tag",
    summary: "The tag was created.",
    facts: [{ label: "Tag name", value: "Billable" }],
    warnings: [],
    references: [{
      id: "ref-1",
      conversationId: "current-session",
      entityType: "tag",
      externalId: "tag-1",
      displayName: "Billable",
      sourceRunId: "structured-run-succeeded",
      bindings: {},
      status: "active",
      verifiedAt: "2026-07-18T10:00:00.000Z",
    }],
  },
  "structured-failed": {
    status: "failed",
    title: "Create a tag",
    summary: "The tag could not be created.",
    facts: [],
    warnings: [{ code: "clockify_error", message: "A tag with that name already exists." }],
    references: [],
  },
  "structured-partial": {
    status: "partial",
    title: "Set up a new project",
    summary: "The project was created, but one member could not be added.",
    facts: [{ label: "Project", value: "Website relaunch" }],
    warnings: [{ code: "member_add_failed", message: "Could not add one member." }],
    references: [],
    recovery: { kind: "retry_read", label: "Check the project's current members", readAttemptId: "retry-1" },
  },
  "structured-cancelled": {
    status: "cancelled",
    title: "Update a project",
    summary: "This change was cancelled before it ran.",
    facts: [],
    warnings: [],
    references: [],
  },
  "structured-outcome-unknown": {
    status: "outcome_unknown",
    title: "Delete a tag",
    summary: "The connection was lost after the request was sent.",
    facts: [],
    warnings: [],
    references: [],
    recovery: { kind: "view_operation", label: "View this operation's status", operationId: "operation-structured-1" },
  },
  "structured-pending": {
    status: "pending_confirmation",
    title: "Delete an archived project",
    summary: "This will permanently remove the project.",
    facts: [{ label: "Project", value: "Old sandbox" }],
    warnings: [],
    references: [],
  },
};

async function streamChat(request, response, state) {
  const { message = "" } = await body(request);
  const structured = STRUCTURED_PRESENTATIONS[message];
  if (structured) {
    const runEvent = structuredRunEvent(`structured-run-${message}`, structured);
    state.messages.push({ role: "user", content: message });
    // A structured attachment carries its own rendering; the transcript keeps
    // only the human bubble (mirrors how run_event-only turns behave for real).
    ndjson(response, [
      runEvent,
      { type: "reply", kind: "final", text: "" },
      { type: "done" },
    ]);
    return;
  }
  let results;
  let reply;
  const requirement = fixtureActionPolicy[message];

  if (requirement && !policyAllows(state.policy, requirement)) {
    results = [deniedReceipt(requirement.action)];
    reply = "That action is disabled by your saved permission policy.";
  } else if (message === "read") {
    results = [receipt("clockify_reports_summary", "Loaded 3 time entries totaling 7h 30m.")];
    reply = "Here is your read-only summary.";
  } else if (message === "safe") {
    results = [{
      ...receipt("clockify_start_timer", "Timer started for Website launch."),
      undo: { id: "undo-safe-1" },
    }];
    reply = "The safe change ran immediately.";
  } else if (message === "risky-confirm" || message === "risky-cancel") {
    results = [preview("risk-1", "Update Website launch", ["Change the project name to Website launch v2"] )];
    reply = "Review this change before it runs.";
  } else if (message === "batch") {
    results = [
      preview("batch-1", "Update Project Alpha", ["Set color to blue"]),
      preview("batch-2", "Update Project Beta", ["Set color to green"]),
    ];
    reply = "Review both changes before they run.";
  } else if (message === "pdf") {
    results = [receipt("clockify_invoices_export", "Invoice PDF is ready.", {
      data: {
        contentType: "application/pdf",
        artifact: {
          id: "invoice-pdf-1",
          downloadUrl: "/api/artifacts/invoice-pdf-1",
          filename: "clockify-invoice-INV-42.pdf",
          expiresAt: "2026-07-18T14:30:00.000Z",
        },
      },
    })];
    reply = "Your authenticated invoice export is ready.";
  } else if (message === "unicode") {
    results = [receipt("clockify_reports_summary", `Loaded project ${unicodeWorkspaceData}.`)];
    reply = "Here is the requested workspace record.";
  } else {
    results = [];
    reply = `Echo: ${message}`;
  }

  remember(state, message, results, reply);
  ndjson(response, [
    ...results.map((result) => ({ type: "result", result })),
    { type: "reply", kind: "final", text: reply },
    { type: "done" },
  ]);
}

function initialState(scenario, theme) {
  return {
    scenario,
    theme,
    permissionsSaved: false,
    policy: scenario === "restricted" ? structuredClone(restrictedPolicy) : structuredClone(fullPolicy),
    activeView: "current",
    messages: scenario === "history"
      ? [
          { role: "user", content: "What did I track yesterday?" },
          {
            role: "assistant",
            content: "You tracked 6 hours yesterday.",
            results: [receipt("clockify_reports_summary", "Loaded yesterday's entries.")],
          },
        ]
      : [],
  };
}

function sessionSummaries() {
  return [
    {
      id: "current-session",
      title: "Current browser test conversation",
      messageCount: 2,
      lastMessageAt: "2026-07-18T10:00:00.000Z",
      createdAt: "2026-07-18T09:00:00.000Z",
      current: true,
    },
    {
      id: "past-session",
      title: "Yesterday's report",
      messageCount: 2,
      lastMessageAt: "2026-07-17T10:00:00.000Z",
      createdAt: "2026-07-17T09:00:00.000Z",
      current: false,
    },
  ];
}

async function serveStatic(request, response, pathname, url) {
  if (url.searchParams.has("language")) {
    return json(response, 400, { ok: false, message: "Language query parameters are unsupported." });
  }
  const existing = stateFor(request);
  let state = existing;
  const setCookies = [];
  if (!state) {
    const id = randomUUID();
    state = initialState(
      url.searchParams.get("scenario") ?? "default",
      url.searchParams.get("theme") ?? "light",
    );
    sessions.set(id, state);
    setCookies.push(`e2e_session=${id}; Path=/; HttpOnly; SameSite=Lax`);
  }

  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/ui\//, "");
  const normalized = normalize(relative).replace(/^(\.\.[/\\])+/, "");
  const file = join(uiRoot, normalized);
  if (!file.startsWith(uiRoot)) return json(response, 404, { ok: false });

  try {
    const info = await stat(file);
    if (!info.isFile()) return json(response, 404, { ok: false });
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
    response.writeHead(200, {
      "content-type": types[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
      ...(setCookies.length ? { "set-cookie": setCookies } : {}),
    });
    createReadStream(file).pipe(response);
  } catch {
    json(response, 404, { ok: false, message: "Not found" });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const { pathname } = url;
  if (pathname === "/healthz") return json(response, 200, { ok: true });

  const state = stateFor(request);
  if (pathname.startsWith("/api/") && !state) {
    return json(response, 401, { ok: false, message: "Authentication required." });
  }

  if (pathname === "/api/me" && request.method === "GET") {
    if (state.scenario === "malformed-me") return json(response, 200, { ok: true, csrfToken: "e2e-csrf" });
    return json(response, 200, {
      ok: true,
      workspaceId: "workspace-e2e",
      adminUserId: "admin-e2e",
      workspaceRole: "ADMIN",
      csrfToken: "e2e-csrf",
      preferences: { theme: state.theme, timeZone: "Europe/Belgrade" },
      links: {
        privacy: "https://example.test/privacy",
        security: "https://example.test/security",
        support: "https://example.test/support",
      },
    });
  }
  if (pathname === "/api/permissions" && request.method === "GET") {
    const policy = state.policy;
    return json(response, 200, {
      ok: true,
      policy,
      firstRun: state.scenario === "first-run" && !state.permissionsSaved,
      featureGroups: Object.keys(policy.groups),
    });
  }
  if (pathname === "/api/permissions/confirm" && request.method === "POST") {
    const submitted = await body(request);
    state.permissionsSaved = true;
    state.policy = { version: state.policy.version + 1, groups: { ...submitted.groups } };
    const policy = state.policy;
    return json(response, 200, {
      ok: true,
      receipt: { ok: true, action: "assistant_update_permissions", message: "Permissions saved." },
      policy,
    });
  }
  if (pathname === "/api/chat/history" && request.method === "GET") {
    if (state.scenario === "slow-history") await new Promise((resolve) => setTimeout(resolve, 900));
    if (state.activeView === "past") {
      return json(response, 200, {
        ok: true,
        messages: [
          { role: "user", content: "Show yesterday's report" },
          { role: "assistant", content: "Yesterday's saved report has 6 hours." },
        ],
        pendingPreviews: [],
      });
    }
    return json(response, 200, { ok: true, messages: state.messages, pendingPreviews: [] });
  }
  if (pathname === "/api/chat/sessions" && request.method === "GET") {
    return json(response, 200, { ok: true, sessions: sessionSummaries() });
  }
  if (pathname === "/api/chat/sessions/past-session/open" && request.method === "POST") {
    state.activeView = "past";
    return json(response, 200, { ok: true });
  }
  if (pathname === "/api/chat/new" && request.method === "POST") {
    state.activeView = "current";
    state.messages = [];
    return json(response, 200, { ok: true });
  }
  if (pathname === "/api/chat/stream" && request.method === "POST") {
    return streamChat(request, response, state);
  }
  if (pathname === "/api/confirmations/risk-1/confirm" && request.method === "POST" && url.searchParams.get("stream") === "1") {
    return ndjson(response, [
      { type: "status", action: "clockify_update_project", label: "Updating the project" },
      { type: "receipt", receipt: { ok: true, action: "clockify_update_project", message: "Project updated." } },
      { type: "reply", kind: "final", text: "The risky change was confirmed and completed." },
      { type: "done" },
    ]);
  }
  if (pathname === "/api/confirmations/risk-1/cancel" && request.method === "POST") {
    return json(response, 200, { ok: true, status: "cancelled" });
  }
  if (pathname === "/api/confirmations/batch-1/confirm" && request.method === "POST") {
    return json(response, 200, { ok: true, receipt: { ok: true, action: "clockify_update_project", message: "Project Alpha updated." } });
  }
  if (pathname === "/api/confirmations/batch-2/confirm" && request.method === "POST") {
    return json(response, 409, { ok: false, code: "target_changed", message: "Project Beta changed after preview." });
  }
  if (pathname === "/api/undo/undo-safe-1" && request.method === "POST") {
    return json(response, 200, { ok: true, receipt: { ok: true, action: "clockify_stop_timer", message: "Timer stopped." } });
  }
  if (pathname === "/api/artifacts/invoice-pdf-1" && request.method === "GET") {
    const pdf = Buffer.from("%PDF-1.4\n% deterministic authenticated e2e fixture\n%%EOF\n");
    response.writeHead(200, {
      "content-type": "application/pdf",
      "content-disposition": 'attachment; filename="clockify-invoice-INV-42.pdf"',
      "content-length": String(pdf.length),
      "cache-control": "no-store",
    });
    return response.end(pdf);
  }

  if (request.method === "GET" && (pathname === "/" || pathname.startsWith("/ui/"))) {
    return serveStatic(request, response, pathname, url);
  }
  return json(response, 404, { ok: false, message: "Not found" });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`E2E UI fixture listening on http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
