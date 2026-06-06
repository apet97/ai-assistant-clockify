import {
  ClockifyAddon,
  ClockifyComponent,
  ClockifyLifecycleEvent,
  ClockifyManifest,
  ClockifyScope,
} from "@apet97/clockify-addon-sdk";

/**
 * Clockify add-on manifest (SPEC / IMPLEMENTATION_PLAN Task 3).
 *
 * One admin-only Activity-tab component renders the chat UI. The add-on
 * requests the read+write scopes the action catalog needs and registers the
 * three lifecycle endpoints the backend serves.
 */
export const ADDON_KEY = "ai-assistant";
export const ADDON_NAME = "AI Assistant";
export const COMPONENT_PATH = "/component/assistant";

export const LIFECYCLE_PATHS = {
  installed: "/lifecycle/installed",
  statusChanged: "/lifecycle/status-changed",
  deleted: "/lifecycle/deleted",
} as const;

const REQUIRED_SCOPES: ClockifyScope[] = [
  ClockifyScope.CLIENT_READ,
  ClockifyScope.CLIENT_WRITE,
  ClockifyScope.PROJECT_READ,
  ClockifyScope.PROJECT_WRITE,
  ClockifyScope.TAG_READ,
  ClockifyScope.TAG_WRITE,
  ClockifyScope.TASK_READ,
  ClockifyScope.TASK_WRITE,
  ClockifyScope.TIME_ENTRY_READ,
  ClockifyScope.TIME_ENTRY_WRITE,
  ClockifyScope.EXPENSE_READ,
  ClockifyScope.EXPENSE_WRITE,
  ClockifyScope.INVOICE_READ,
  ClockifyScope.INVOICE_WRITE,
  ClockifyScope.USER_READ,
  ClockifyScope.USER_WRITE,
  ClockifyScope.GROUP_READ,
  ClockifyScope.GROUP_WRITE,
  ClockifyScope.WORKSPACE_READ,
  ClockifyScope.WORKSPACE_WRITE,
  ClockifyScope.CUSTOM_FIELDS_READ,
  ClockifyScope.CUSTOM_FIELDS_WRITE,
  ClockifyScope.APPROVAL_READ,
  ClockifyScope.APPROVAL_WRITE,
  ClockifyScope.SCHEDULING_READ,
  ClockifyScope.SCHEDULING_WRITE,
  ClockifyScope.REPORTS_READ,
  ClockifyScope.REPORTS_WRITE,
  ClockifyScope.TIME_OFF_READ,
  ClockifyScope.TIME_OFF_WRITE,
];

export function buildManifest(baseUrl: string): ClockifyManifest<"1.5"> {
  const component = ClockifyComponent.v1_5Builder()
    .activityTab()
    .allowAdmins()
    .path(COMPONENT_PATH)
    .label(ADDON_NAME)
    .build();

  const lifecycle = [
    ClockifyLifecycleEvent.v1_5Builder().path(LIFECYCLE_PATHS.installed).onInstalled().build(),
    ClockifyLifecycleEvent.v1_5Builder()
      .path(LIFECYCLE_PATHS.statusChanged)
      .onStatusChanged()
      .build(),
    ClockifyLifecycleEvent.v1_5Builder().path(LIFECYCLE_PATHS.deleted).onDeleted().build(),
  ];

  return ClockifyManifest.v1_5Builder()
    .key(ADDON_KEY)
    .name(ADDON_NAME)
    .baseUrl(baseUrl)
    .requireProPlan()
    .description("Admin-only AI assistant for Clockify workspace operations.")
    .scopes(REQUIRED_SCOPES)
    .components([component])
    .lifecycle(lifecycle)
    .build();
}

export function buildAddon(baseUrl: string): ClockifyAddon<ClockifyManifest<"1.5">> {
  return new ClockifyAddon(buildManifest(baseUrl));
}
