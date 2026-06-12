import { z } from "zod";
import { CLOCKIFY_PLATFORM_PUBLIC_KEY_PEM } from "./addon/clockify-public-key.js";

/**
 * Application configuration loaded and validated from environment variables
 * (TECH_STACK "Environment Variables"). All boundaries are Zod-validated.
 *
 * DATA_ENCRYPTION_KEY is optional only when NODE_ENV === "test"; otherwise the
 * process must fail to start without it (SPEC "Security Requirements").
 */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  baseUrl: string;
  clockifyAddonPublicKeyPem: string;
  clockifyAddonKey: string;
  sessionSecret: string;
  dataEncryptionKey?: string;
  databasePath: string;
  /** Planner backend: "http" (OpenAI-compatible endpoint) or "gemini-cli" (dev). */
  llmProvider: "http" | "gemini-cli";
  /** Planner mode: "tool" (native function-calling, default) or "json" (JSON + repair).
   *  Tool mode only applies when the backend supports it (the http client does). */
  llmMode?: "tool" | "json";
  /** Agentic loop: when true, the chat turn runs the durable tool-loop
   *  (read-then-act + resume across the confirm round-trip). Default ON after the
   *  live acceptance proof; set LLM_AGENTIC=0 to roll back to single-turn. */
  llmAgentic?: boolean;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  /** Per-request model timeout (ms); the HTTP client defaults to 120s when unset. */
  llmTimeoutMs?: number;
  /** Provider thinking control passed through as reasoning_effort. */
  llmReasoningEffort?: string;
  /** Optional Gemini model for the gemini-cli provider (else the CLI router picks). */
  geminiModel?: string;
  /** Chat rate limit per admin session; the route defaults apply when unset. */
  chatRateLimitMax?: number;
  chatRateLimitWindowMs?: number;
}

const envObjectSchema = z.object({
  NODE_ENV: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive(),
  BASE_URL: z.string().min(1),
  CLOCKIFY_ADDON_PUBLIC_KEY_PEM: z.string().min(1).optional(),
  CLOCKIFY_ADDON_KEY: z.string().min(1),
  SESSION_SECRET: z.string().min(1),
  DATA_ENCRYPTION_KEY: z.string().min(1).optional(),
  DATABASE_PATH: z.string().min(1),
  // The HTTP provider needs base/key/model; the gemini-cli provider needs none
  // (it uses the authenticated CLI), so these are optional here and enforced
  // below only for the http provider.
  LLM_PROVIDER: z.enum(["http", "gemini-cli"]).default("http"),
  LLM_MODE: z.enum(["tool", "json"]).default("tool"),
  // Default ON: the durable agentic loop is the proven default (live PASS=10,
  // adversarial review all-HELD). LLM_AGENTIC=0 is the instant rollback.
  LLM_AGENTIC: z.enum(["0", "1"]).default("1"),
  LLM_BASE_URL: z.string().min(1).optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_MODEL: z.string().min(1).optional(),
  /** Per-request model timeout (ms); the client defaults to 120s when unset. */
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  /** Provider thinking control (e.g. "none" disables Gemini thinking). */
  LLM_REASONING_EFFORT: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().min(1).optional(),
  /** Chat rate limit per admin session (each turn drives a paid model loop). */
  CHAT_RATE_LIMIT_MAX: z.coerce.number().int().positive().optional(),
  CHAT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().optional(),
});

const envSchema = envObjectSchema.superRefine((v, ctx) => {
  if (v.LLM_PROVIDER === "http") {
    for (const key of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"] as const) {
      if (!v[key]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${key} is required when LLM_PROVIDER=http`, path: [key] });
      }
    }
  }
});

/**
 * Every environment variable the schema accepts. `.env.example` must document
 * each one (required values uncommented, optional knobs as commented entries) so
 * the README's "full list" claim stays true; a unit test pins this (no schema
 * key may silently skip the template).
 */
export const ENV_SCHEMA_KEYS: readonly string[] = Object.keys(envObjectSchema.shape);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const nodeEnv = parsed.NODE_ENV ?? "development";

  if (nodeEnv !== "test" && !parsed.DATA_ENCRYPTION_KEY) {
    throw new Error(
      "DATA_ENCRYPTION_KEY is required outside NODE_ENV=test (installation tokens must not be stored in plaintext).",
    );
  }

  return {
    nodeEnv,
    port: parsed.PORT,
    baseUrl: parsed.BASE_URL,
    // Clockify signs every add-on token with one platform-wide key. Default to
    // the built-in key so install/lifecycle verification works out of the box;
    // the env var only overrides it for other Clockify environments/regions.
    clockifyAddonPublicKeyPem:
      parsed.CLOCKIFY_ADDON_PUBLIC_KEY_PEM ?? CLOCKIFY_PLATFORM_PUBLIC_KEY_PEM,
    clockifyAddonKey: parsed.CLOCKIFY_ADDON_KEY,
    sessionSecret: parsed.SESSION_SECRET,
    dataEncryptionKey: parsed.DATA_ENCRYPTION_KEY,
    databasePath: parsed.DATABASE_PATH,
    llmProvider: parsed.LLM_PROVIDER,
    llmMode: parsed.LLM_MODE,
    llmAgentic: parsed.LLM_AGENTIC === "1",
    llmBaseUrl: parsed.LLM_BASE_URL,
    llmApiKey: parsed.LLM_API_KEY,
    llmModel: parsed.LLM_MODEL,
    llmTimeoutMs: parsed.LLM_TIMEOUT_MS,
    llmReasoningEffort: parsed.LLM_REASONING_EFFORT,
    geminiModel: parsed.GEMINI_MODEL,
    chatRateLimitMax: parsed.CHAT_RATE_LIMIT_MAX,
    chatRateLimitWindowMs: parsed.CHAT_RATE_LIMIT_WINDOW_MS,
  };
}
