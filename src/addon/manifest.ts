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
 * One admin-only left-sidebar component renders the chat UI (a dedicated nav
 * entry, not buried as a tab on the Activity page). The add-on requests the
 * read+write scopes the action catalog needs and registers the three lifecycle
 * endpoints the backend serves.
 */
export const ADDON_KEY = "ai-assistant";
const ADDON_NAME = "AI Assistant";
const COMPONENT_PATH = "/component/assistant";
export const ICON_PATH = "/icon.svg";

/**
 * Inline icon served at {@link ICON_PATH}. Clockify's left sidebar is an icon
 * rail, so a `sidebar` component needs an add-on icon or the nav entry does not
 * render at all (verified against the working sibling add-ons `breakcheck` and
 * `clockify-deviceflow-addon`, both of which ship a top-level `iconPath`). The
 * label becomes the hover tooltip.
 */
export const ADDON_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="#1f6feb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' +
  '<path d="M12 8v4M12 15.5h.01M9.5 10.5h5" stroke-width="1.6"/></svg>';

const LIFECYCLE_PATHS = {
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
    .sidebar()
    .allowAdmins()
    .path(COMPONENT_PATH)
    .label(ADDON_NAME)
    .iconPath(ICON_PATH)
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
    .iconPath(ICON_PATH)
    .scopes(REQUIRED_SCOPES)
    .components([component])
    .lifecycle(lifecycle)
    .build();
}

export function buildAddon(baseUrl: string): ClockifyAddon<ClockifyManifest<"1.5">> {
  return new ClockifyAddon(buildManifest(baseUrl));
}
