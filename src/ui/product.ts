/** User-owned presentation preferences and policy-aware onboarding copy. */
import type { PolicyShape } from "./shared.js";
import type { UiLanguage, UiPreferences } from "../shared/contracts.js";

export type { UiLanguage, UiPreferences, UiTheme } from "../shared/contracts.js";

export const DEFAULT_UI_PREFERENCES: UiPreferences = { theme: "system", language: "en" };
export const UI_PREFERENCES_KEY = "clockify-ai-assistant.preferences.v1";

export function intlLocale(language: UiLanguage): string {
  return language === "sr" ? "sr-Latn-RS" : "en-US";
}

export function normalizeUiPreferences(value: unknown): UiPreferences {
  if (!value || typeof value !== "object") return DEFAULT_UI_PREFERENCES;
  const source = value as Partial<UiPreferences>;
  if ((source.theme !== "system" && source.theme !== "light" && source.theme !== "dark") || (source.language !== "en" && source.language !== "sr")) {
    return DEFAULT_UI_PREFERENCES;
  }
  return {
    theme: source.theme,
    language: source.language,
    ...(typeof source.timeZone === "string" && source.timeZone ? { timeZone: source.timeZone } : {}),
  };
}

export function loadUiPreferences(storage: Pick<Storage, "getItem">): UiPreferences {
  try {
    const raw = storage.getItem(UI_PREFERENCES_KEY);
    return normalizeUiPreferences(raw ? JSON.parse(raw) : undefined);
  } catch {
    return DEFAULT_UI_PREFERENCES;
  }
}

export function saveUiPreferences(storage: Pick<Storage, "setItem">, preferences: UiPreferences): void {
  storage.setItem(UI_PREFERENCES_KEY, JSON.stringify(normalizeUiPreferences(preferences)));
}

export function applyUiPreferences(root: HTMLElement, preferences: UiPreferences): void {
  root.lang = preferences.language;
  root.dataset.theme = preferences.theme;
  if (preferences.timeZone) root.dataset.timeZone = preferences.timeZone;
  else delete root.dataset.timeZone;
}

export function formatLocalDateTime(value: string, language: UiLanguage, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(intlLocale(language), {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

export function formatLocalCurrency(amount: number, currency: string, language: UiLanguage): string {
  if (!Number.isFinite(amount) || !/^[A-Z]{3}$/.test(currency)) return `${amount} ${currency}`;
  return new Intl.NumberFormat(intlLocale(language), {
    style: "currency",
    currency,
  }).format(amount);
}

/** Intl-derived localized timezone name plus the stable IANA identifier. The
 * identifier remains visible because localized names can be ambiguous around
 * daylight-saving transitions. */
export function formatTimeZoneName(
  timeZone: string,
  language: UiLanguage,
  at: Date = new Date(),
): string {
  try {
    const name = new Intl.DateTimeFormat(intlLocale(language), {
      timeZone,
      timeZoneName: "long",
    }).formatToParts(at).find((part) => part.type === "timeZoneName")?.value;
    return name ? `${name} (${timeZone})` : timeZone;
  } catch {
    return timeZone;
  }
}

const PROMPTS: Array<{ group: string; access: "read" | "read_write"; text: string | ((language: UiLanguage) => string) }> = [
  { group: "time_tracking", access: "read", text: "What did I track today?" },
  { group: "reports", access: "read", text: "Show this week's summary report" },
  { group: "time_tracking", access: "read_write", text: "Start a timer for deep work" },
  { group: "time_tracking", access: "read_write", text: "Log 2 hours on a project with a tag for yesterday" },
  { group: "expenses", access: "read_write", text: (language) => `Log a ${formatLocalCurrency(50, "USD", language)} travel expense on a project` },
  { group: "invoices", access: "read_write", text: "Invoice a client, due next month" },
  { group: "time_off_approvals", access: "read_write", text: "Request 2 days off next week" },
  { group: "workspace_settings", access: "read", text: "What did you change recently?" },
];

/** Only suggest a capability when the admin's current policy allows it. */
export function promptsForPolicy(policy?: PolicyShape, language: UiLanguage = "en"): string[] {
  const available = PROMPTS.filter(({ group, access }) => {
    if (!policy) return true;
    const level = policy.groups[group] ?? "off";
    return access === "read" ? level === "read" || level === "read_write" : level === "read_write";
  }).map(({ text }) => typeof text === "function" ? text(language) : text);
  return available.length > 0 ? available : ["How do assistant permissions work?"];
}

/** Welcome capability statement derived from the current saved policy. */
export function welcomeCopyForPolicy(policy?: PolicyShape): string {
  const levels = Object.values(policy?.groups ?? {});
  if (!policy || levels.includes("read_write")) {
    return "I can read permitted Clockify data and make permitted changes. Safe changes run immediately with receipts; anything risky shows a preview you confirm with a button.";
  }
  if (levels.includes("read")) {
    return "I can read the permitted parts of this Clockify workspace. Changes are disabled by your saved permission policy.";
  }
  return "Your saved permission policy currently disables workspace access. Open Assistant permissions to enable the areas you want me to use.";
}

/** Exact first-run disclosure: accurate where local policy is known, candid where provider posture is operator-owned. */
export function firstRunDisclosure(): string {
  return "DeepSeek processes chat requests for this assistant. We keep chat and audit records locally for 90 days by default; invoice downloads expire after 60 minutes. Your provider's retention, region, and training settings are controlled by the operator. The assistant proposes actions only: risky changes require a preview and a button confirmation; typing yes never confirms.";
}
