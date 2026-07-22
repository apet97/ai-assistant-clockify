import type { UiPreferences } from "./shared/contracts.js";

/** Sanitize verified Clockify user-token display claims to supported UI values. */
export function clockifyUiPreferences(theme: unknown, timeZone: unknown): UiPreferences {
  const normalizedTheme = typeof theme === "string" ? theme.trim().toUpperCase() : "";
  let verifiedTimeZone: string | undefined;
  if (typeof timeZone === "string" && timeZone.length <= 100) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
      verifiedTimeZone = timeZone;
    } catch {
      // Omit invalid/unverified zones rather than letting them reach Intl in the browser.
    }
  }
  return {
    theme: normalizedTheme === "DARK" ? "dark" : normalizedTheme === "LIGHT" ? "light" : "system",
    ...(verifiedTimeZone ? { timeZone: verifiedTimeZone } : {}),
  };
}
