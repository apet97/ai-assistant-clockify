import type {
  TimeEntryPort,
  ProjectPort,
  TaskPort,
  ClientPort,
  TagPort,
  InvoicePort,
  ExpensePort,
  CustomFieldPort,
  TimeOffPort,
  HolidayPort,
  SchedulingPort,
  ApprovalPort,
  ReportPort,
  AuditPort,
  WorkspacePort,
  UserPort,
  WebhookPort,
  MiscRiskyPort,
} from "./ports/index.js";

/**
 * The Clockify workspace-client port (backend rule: all Clockify access goes
 * through the {@link WorkspaceClient} composed below). The add-on authenticates
 * with the stored installation token via `X-Addon-Token` — never an API key —
 * and targets the backend URL from verified token claims.
 */

// Re-export the shared entity-summary shapes from the dependency-free leaf
// module so external importers of `clockify/client.js` still resolve them. The
// port slices and the REST adapter import them from `./types.js` directly (this
// is what breaks the client <-> ports cycle).
export type {
  EntitySummary,
  ProjectSummary,
  TaskSummary,
  TimeEntrySummary,
  StartTimeEntryInput,
  CreateTimeEntryInput,
} from "./types.js";

/**
 * Workspace-client port: the narrow Clockify surface the harness workflows use.
 * Composed (decision D1) from per-area sub-interfaces — each feature area's
 * method slice lives in `./ports/<area>.ts`. Call sites are unchanged
 * (`ctx.clockify.listProjects()`); risky/commit-only methods stay optional. The
 * test fake and the live REST adapter both implement this composed interface.
 */
export interface WorkspaceClient
  extends TimeEntryPort,
    ProjectPort,
    TaskPort,
    ClientPort,
    TagPort,
    InvoicePort,
    ExpensePort,
    CustomFieldPort,
    TimeOffPort,
    HolidayPort,
    SchedulingPort,
    ApprovalPort,
    ReportPort,
    AuditPort,
    WorkspacePort,
    UserPort,
    WebhookPort,
    MiscRiskyPort {
  /**
   * The auth class this client calls Clockify with. Clockify refuses some
   * endpoint FAMILIES for add-on tokens regardless of manifest scopes (probed
   * live 2026-06-10: webhooks, custom-field management) — preview-time honesty
   * keys on this so a doomed write is never offered for confirmation. Absent
   * (tests/dev API key) means unrestricted.
   */
  authClass?: "addon" | "api_key";
}

// Re-export the port slices so importers can depend on a single barrel
// (`clockify/client.js`) for both the composed port and its pieces.
export type {
  TimeEntryPort,
  ProjectPort,
  TaskPort,
  ClientPort,
  TagPort,
  InvoicePort,
  ExpensePort,
  CustomFieldPort,
  TimeOffPort,
  HolidayPort,
  SchedulingPort,
  ApprovalPort,
  ReportPort,
  AuditPort,
  WorkspacePort,
  UserPort,
  WebhookPort,
  MiscRiskyPort,
} from "./ports/index.js";
