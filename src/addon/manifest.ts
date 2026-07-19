import {
  ClockifyAddon,
  ClockifyComponent,
  ClockifyLifecycleEvent,
  ClockifyManifest,
} from "@apet97/clockify-addon-sdk";
import { REQUIRED_SCOPES } from "./scope-contract.js";

/**
 * Clockify add-on manifest (SPEC / IMPLEMENTATION_PLAN Task 3).
 *
 * One admin-only left-sidebar component renders the chat UI (a dedicated nav
 * entry, not buried as a tab on the Activity page). The add-on requests the
 * read+write scopes the action catalog needs and registers the three lifecycle
 * endpoints the backend serves.
 */
export const ADDON_KEY = "ai-assistant";
const ADDON_NAME = "AI Assistant for Clockify";
const COMPONENT_LABEL = "AI Assistant";
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
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" aria-label="AI Assistant" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<rect width="24" height="24" rx="5" fill="#0e1116"/>' +
  '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h8A2.5 2.5 0 0 1 17 5.5v6a2.5 2.5 0 0 1-2.5 2.5H10l-3.7 3.1A.8.8 0 0 1 5 16.5V14a2.5 2.5 0 0 1-1-2V5.5Z" fill="#5b9bff"/>' +
  '<path d="M7 7h7M7 10h4" fill="none" stroke="#f7f9fc" stroke-width="1.5"/>' +
  '<circle cx="17.5" cy="17.5" r="4" fill="#0e1116" stroke="#3fce8b" stroke-width="1.5"/>' +
  '<path d="m15.8 17.5 1.1 1.1 2.4-2.7" fill="none" stroke="#3fce8b" stroke-width="1.5"/></svg>';

const LIFECYCLE_PATHS = {
  installed: "/lifecycle/installed",
  statusChanged: "/lifecycle/status-changed",
  deleted: "/lifecycle/deleted",
} as const;

export function buildManifest(baseUrl: string): ClockifyManifest<"1.5"> {
  const component = ClockifyComponent.v1_5Builder()
    .sidebar()
    .allowAdmins()
    .path(COMPONENT_PATH)
    .label(COMPONENT_LABEL)
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
