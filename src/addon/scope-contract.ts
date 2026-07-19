import { ClockifyScope } from "@apet97/clockify-addon-sdk";
import { createHash } from "node:crypto";
import type { FeatureGroup } from "../harness/permissions.js";

export type ScopeAccess = "read" | "write";

/** Primary Clockify add-on authorization contract used to justify necessity:
 * scopes are resource + READ/WRITE permissions and an endpoint without its
 * appropriate declared manifest scope fails with HTTP 403. Keeping the
 * normalized statement hash in live evidence makes the exact platform rule
 * reviewed by the release gate explicit and tamper-evident. */
export const CLOCKIFY_SCOPE_ENFORCEMENT_SOURCE =
  "https://dev-docs.marketplace.cake.com/clockify/build/manifest#scopes";
export const CLOCKIFY_SCOPE_ENFORCEMENT_CONTRACT =
  "Clockify add-on scopes are resource-and-action permissions; calling an endpoint without its appropriate declared manifest scope fails with HTTP 403.";
export const CLOCKIFY_SCOPE_ENFORCEMENT_SHA256 = createHash("sha256")
  .update(CLOCKIFY_SCOPE_ENFORCEMENT_CONTRACT)
  .digest("hex");

/**
 * Minimal source map used by the build-time endpoint extractor. Endpoint rows
 * are deliberately not hand-authored here: scripts/generate-endpoint-scope-
 * contract.ts discovers exact RestCore calls from these adapter modules and
 * rejects any adapter call which is not assigned to a retained scope.
 */
export interface EndpointScopeSource {
  scope: ClockifyScope;
  access: ScopeAccess;
  adapterModules: readonly string[];
  /** Regex sources matched against normalized, query-free adapter paths. */
  pathPatterns: readonly string[];
  /** Catalog feature groups which may consume this capability. This is a
   *  conservative reviewer cross-check, not an action-to-endpoint call graph. */
  catalogFeatureGroups: readonly FeatureGroup[];
  probes: readonly string[];
}

const pair = (
  readScope: ClockifyScope,
  writeScope: ClockifyScope,
  input: Omit<EndpointScopeSource, "scope" | "access">,
): EndpointScopeSource[] => [
  { scope: readScope, access: "read", ...input },
  { scope: writeScope, access: "write", ...input },
];

/**
 * Install-time permission sources. The generated reviewer artifact adds the
 * exact endpoints discovered from the adapter and conservative action-group
 * counts read from ACTION_CATALOG. A fresh-install probe is still required as release
 * evidence; static tests cannot prove the permissions on a newly issued token.
 */
export const ENDPOINT_SCOPE_SOURCES: readonly EndpointScopeSource[] = [
  ...pair(ClockifyScope.CLIENT_READ, ClockifyScope.CLIENT_WRITE, {
    adapterModules: ["clients.ts"],
    pathPatterns: ["^/workspaces/\\{workspaceId\\}/clients(?:/|$)"],
    catalogFeatureGroups: ["work_structure"],
    probes: ["tests/unit/rest-clients.test.ts"],
  }),
  ...pair(ClockifyScope.PROJECT_READ, ClockifyScope.PROJECT_WRITE, {
    adapterModules: ["projects.ts", "workspace.ts"],
    pathPatterns: ["^/workspaces/\\{workspaceId\\}/projects(?:/|$)"],
    catalogFeatureGroups: ["work_structure", "invoices", "users_groups"],
    probes: ["tests/unit/rest-projects.test.ts", "tests/unit/rest-workspace-settings.test.ts"],
  }),
  ...pair(ClockifyScope.TAG_READ, ClockifyScope.TAG_WRITE, {
    adapterModules: ["tags.ts"],
    pathPatterns: ["^/workspaces/\\{workspaceId\\}/tags(?:/|$)"],
    catalogFeatureGroups: ["work_structure"],
    probes: ["tests/unit/rest-tags.test.ts"],
  }),
  ...pair(ClockifyScope.TASK_READ, ClockifyScope.TASK_WRITE, {
    adapterModules: ["tasks.ts"],
    pathPatterns: ["^/workspaces/\\{workspaceId\\}/projects/\\{projectId\\}/tasks(?:/|$)"],
    catalogFeatureGroups: ["work_structure", "invoices"],
    probes: ["tests/unit/rest-tasks.test.ts"],
  }),
  ...pair(ClockifyScope.TIME_ENTRY_READ, ClockifyScope.TIME_ENTRY_WRITE, {
    // Custom-field reads/updates reuse the time-entry wire path but are
    // permissioned as CUSTOM_FIELDS_* operations; keep those callsites solely
    // in the custom-fields source below so one adapter callsite has one scope.
    adapterModules: ["time-entries.ts"],
    pathPatterns: [
      "^/workspaces/\\{workspaceId\\}/(?:user/\\{userId\\}/)?time-entries(?:/|$)",
    ],
    catalogFeatureGroups: ["time_tracking", "invoices", "custom_fields"],
    probes: ["tests/unit/rest-time-entries.test.ts", "tests/unit/rest-custom-fields.test.ts"],
  }),
  ...pair(ClockifyScope.EXPENSE_READ, ClockifyScope.EXPENSE_WRITE, {
    adapterModules: ["expenses.ts"],
    pathPatterns: ["^/workspaces/\\{workspaceId\\}/expenses(?:/|$)"],
    catalogFeatureGroups: ["expenses"],
    probes: ["tests/unit/rest-expenses.test.ts"],
  }),
  ...pair(ClockifyScope.INVOICE_READ, ClockifyScope.INVOICE_WRITE, {
    adapterModules: ["invoices.ts"],
    pathPatterns: ["^/workspaces/\\{workspaceId\\}/invoices(?:/|$)"],
    catalogFeatureGroups: ["invoices"],
    probes: ["tests/unit/rest-invoices.test.ts"],
  }),
  ...pair(ClockifyScope.USER_READ, ClockifyScope.USER_WRITE, {
    adapterModules: ["users.ts"],
    pathPatterns: ["^/workspaces/\\{workspaceId\\}/users(?:/|$)"],
    catalogFeatureGroups: ["users_groups", "invoices"],
    probes: ["tests/unit/rest-users.test.ts"],
  }),
  ...pair(ClockifyScope.GROUP_READ, ClockifyScope.GROUP_WRITE, {
    adapterModules: ["users.ts"],
    pathPatterns: ["^/workspaces/\\{workspaceId\\}/user-groups(?:/|$)"],
    catalogFeatureGroups: ["users_groups"],
    probes: ["tests/unit/rest-users.test.ts"],
  }),
  ...pair(ClockifyScope.WORKSPACE_READ, ClockifyScope.WORKSPACE_WRITE, {
    adapterModules: ["workspace.ts", "clients.ts", "users.ts", "holidays.ts", "webhooks.ts", "audit.ts"],
    pathPatterns: [
      "^/workspaces/\\{workspaceId\\}$",
      "^/workspaces/\\{workspaceId\\}/(?:holidays|webhooks|entities|audit-log)(?:/|$)",
    ],
    catalogFeatureGroups: [
      "workspace_settings",
      "work_structure",
      "users_groups",
      "time_off_approvals",
      "webhooks",
      "audit_log",
    ],
    probes: [
      "tests/unit/rest-workspace-settings.test.ts",
      "tests/unit/rest-holidays.test.ts",
      "tests/unit/rest-webhooks.test.ts",
      "tests/unit/rest-audit.test.ts",
    ],
  }),
  ...pair(ClockifyScope.CUSTOM_FIELDS_READ, ClockifyScope.CUSTOM_FIELDS_WRITE, {
    adapterModules: ["custom-fields.ts"],
    pathPatterns: [
      "^/workspaces/\\{workspaceId\\}/custom-fields(?:/|$)",
      "^/workspaces/\\{workspaceId\\}/projects/\\{projectId\\}/custom-fields(?:/|$)",
      "^/workspaces/\\{workspaceId\\}/time-entries(?:/|$)",
    ],
    catalogFeatureGroups: ["custom_fields"],
    probes: ["tests/unit/rest-custom-fields.test.ts"],
  }),
  ...pair(ClockifyScope.APPROVAL_READ, ClockifyScope.APPROVAL_WRITE, {
    adapterModules: ["approvals.ts"],
    pathPatterns: ["^/workspaces/\\{workspaceId\\}/approval-requests(?:/|$)"],
    catalogFeatureGroups: ["approvals"],
    probes: ["tests/unit/rest-approvals.test.ts"],
  }),
  ...pair(ClockifyScope.SCHEDULING_READ, ClockifyScope.SCHEDULING_WRITE, {
    adapterModules: ["scheduling.ts"],
    pathPatterns: ["^/workspaces/\\{workspaceId\\}/scheduling/assignments(?:/|$)"],
    catalogFeatureGroups: ["scheduling"],
    probes: ["tests/unit/rest-scheduling.test.ts"],
  }),
  {
    scope: ClockifyScope.REPORTS_READ,
    access: "read",
    adapterModules: ["reports.ts"],
    pathPatterns: ["^/workspaces/\\{workspaceId\\}/reports/(?:summary|detailed|weekly)$"],
    catalogFeatureGroups: ["reports"],
    probes: ["tests/unit/rest-reports.test.ts"],
  },
  ...pair(ClockifyScope.TIME_OFF_READ, ClockifyScope.TIME_OFF_WRITE, {
    adapterModules: ["time-off.ts"],
    pathPatterns: ["^/workspaces/\\{workspaceId\\}/time-off(?:/|$)"],
    catalogFeatureGroups: ["time_off_approvals"],
    probes: ["tests/unit/rest-time-off.test.ts"],
  }),
];

export const REQUIRED_SCOPES: ClockifyScope[] = ENDPOINT_SCOPE_SOURCES.map(({ scope }) => scope);
