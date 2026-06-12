/**
 * Human-readable progress labels for the streaming status events. Derived ONLY
 * from the action NAME — never the arguments (they can contain admin text and
 * must not ride an ephemeral stream line). Leaf module: imports nothing.
 */

/** Curated labels where the mechanical fallback reads poorly. */
const LABEL_OVERRIDES: Record<string, string> = {
  clockify_status: "Checking the timer",
  clockify_start_timer: "Starting the timer",
  clockify_stop_timer: "Stopping the timer",
  clockify_log_work: "Logging the time entry",
  clockify_fix_entry: "Updating the time entry",
  clockify_review_day: "Reviewing the day",
  clockify_review_week: "Reviewing the week",
  clockify_period_report: "Building the period report",
  clockify_create_work_package: "Setting up the work package",
  clockify_onboard_user: "Onboarding the user",
  assistant_recent_outcomes: "Checking the audit log",
  assistant_show_permissions: "Reading your assistant permissions",
  assistant_update_permissions: "Preparing the permissions change",
};

/**
 * "clockify_projects_rate_update" → "Projects rate update". Deterministic,
 * never empty (an unknown/odd name falls back to "Working").
 */
export function actionStatusLabel(actionName: string): string {
  const override = LABEL_OVERRIDES[actionName];
  if (override) return override;
  const words = actionName
    .replace(/^(clockify|assistant)_/, "")
    .split("_")
    .filter((w) => w.length > 0);
  if (words.length === 0) return "Working";
  const sentence = words.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
