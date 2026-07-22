/** Cross-boundary product contracts shared by the server and framework-free UI. */

export type UiTheme = "system" | "light" | "dark";

export interface UiPreferences {
  theme: UiTheme;
  /** Verified Clockify timezone when available; omitted rather than guessed. */
  timeZone?: string;
}

export interface ArtifactDescriptor {
  downloadUrl: string;
  filename: string;
  expiresAt: string;
}

/**
 * Complete cross-boundary NDJSON contract. Payload generics let the server keep
 * its canonical action-result types while the browser substitutes its decoded
 * render types; neither side can invent or silently accept another event kind.
 */
export type ChatEvent<TResult = unknown, TReceipt = unknown> =
  | { type: "result"; result: TResult; persistenceDegraded?: boolean }
  | { type: "receipt"; receipt: TReceipt; undo?: { id: string }; persistenceDegraded?: boolean }
  | { type: "reply"; text: string; kind?: string }
  | { type: "error"; message: string; code?: string }
  | { type: "status"; label: string; action?: string }
  | { type: "done" };

export interface PublicProductLinks {
  privacy: string;
  support: string;
  security: string;
}
