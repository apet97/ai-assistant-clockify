import { createHash } from "node:crypto";

export const DEEPSEEK_API_ORIGIN = "https://api.deepseek.com";
export const DEEPSEEK_RELEASE_MODEL = "deepseek-v4-pro";

function parseSafeHttpsBase(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid model endpoint");
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("Invalid model endpoint");
  }
  return url;
}

/**
 * Normalize an OpenAI-compatible HTTPS base without ever accepting URL
 * credentials, a query, or a fragment. The client applies this even in local
 * tools so a bearer key cannot be attached to a malformed destination.
 */
export function normalizeModelBaseUrl(raw: string): string {
  const url = parseSafeHttpsBase(raw);
  url.pathname = url.pathname === "/" ? "/" : `${url.pathname.replace(/\/+$/u, "")}/`;
  return url.toString();
}

/** Production is intentionally not a generic OpenAI-compatible proxy. The 1.0
 * release is DeepSeek-only, and startup fails before a key or prompt can leave
 * the process unless the configured endpoint is one of DeepSeek's documented
 * equivalent bases and the release-tested model is selected. */
export function assertProductionDeepSeekConfiguration(input: {
  provider: "http" | "gemini-cli";
  baseUrl?: string;
  model?: string;
}): void {
  if (input.provider !== "http" || input.baseUrl === undefined || input.model !== DEEPSEEK_RELEASE_MODEL) {
    throw new Error("Production model configuration must use the approved DeepSeek provider and model");
  }
  let url: URL;
  try {
    url = parseSafeHttpsBase(input.baseUrl);
  } catch {
    throw new Error("Production model configuration must use the approved DeepSeek endpoint");
  }
  const pathname = url.pathname.replace(/\/+$/u, "") || "/";
  if (url.origin !== DEEPSEEK_API_ORIGIN || (pathname !== "/" && pathname !== "/v1")) {
    throw new Error("Production model configuration must use the approved DeepSeek endpoint");
  }
}

export function modelEndpointSha256(raw: string): string {
  return createHash("sha256").update(normalizeModelBaseUrl(raw)).digest("hex");
}

export function modelChatCompletionsUrl(raw: string): string {
  const base = new URL(normalizeModelBaseUrl(raw));
  base.pathname = `${base.pathname.replace(/\/+$/u, "")}/chat/completions`;
  return base.toString();
}
