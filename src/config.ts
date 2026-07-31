import { z } from "zod";
import { CLOCKIFY_PLATFORM_PUBLIC_KEY_PEM } from "./addon/clockify-public-key.js";
import {
  assertProductionDeepSeekConfiguration,
  modelEndpointSha256,
} from "./assistant/model-endpoint.js";

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
  /** Monitored customer contact destination rendered on public support/privacy/security pages. */
  publicContactUrl?: string;
  /** Immutable source identity supplied to the deployed release candidate. */
  releaseSha?: string;
  releaseBuildHash?: string;
  /** SHA-256 of the pre-upload source-candidate binding used by Git-less builders. */
  releaseSourceBindingSha256?: string;
  clockifyAddonPublicKeyPem: string;
  clockifyAddonKey: string;
  sessionSecret: string;
  /** Signed-session lifetime (ms). Every authenticated API request also rechecks the
   *  current workspace role; this TTL bounds cookie lifetime and chat-history scope,
   *  not authorization freshness. loadConfig always sets it (default 2h,
   *  SESSION_TTL_HOURS); the store falls back to 8h only for legacy direct callers. */
  sessionTtlMs: number;
  /** @deprecated Compatibility-only config field. Role rechecking is mandatory;
   *  callers cannot disable it. Kept for one release so an existing ROLE_RECHECK
   *  deployment variable does not become an unknown configuration input. */
  roleRecheckEnabled?: boolean;
  /** Cache window (ms) for a passed admin re-check. Default 60000. */
  roleRecheckTtlMs?: number;
  dataEncryptionKey?: string;
  /** Previous at-rest key accepted once at startup to re-encrypt installation tokens. */
  dataEncryptionKeyPrevious?: string;
  databasePath: string;
  /** F24: the deploy's recorded database-boundary claim (fresh vs reopened). */
  databasePathDisposition?: "new_unused" | "existing_expected";
  /** Planner backend: "http" (OpenAI-compatible endpoint) or "gemini-cli" (dev). */
  llmProvider: "http" | "gemini-cli";
  /** Atomic rewrite switch. V1 remains the default until an authorized cutover. */
  assistantEngine: "v1" | "v2";
  /** Planner mode: "tool" (native function-calling, default) or "json" (JSON + repair).
   *  EFFECT (re-verified T02): this IS consumed. src/routes/chat-pipeline.ts derives
   *  `useTools = llmMode !== "json"` (chat turn) and gates the agentic resume on
   *  `llmMode !== "json"`. So LLM_MODE=json forces the validated JSON+repair path on
   *  BOTH backends (it disables native tool-calling even on the http client, which
   *  otherwise always exposes completeWithTools). On gemini-cli the JSON path is used
   *  regardless, since that backend has no completeWithTools. */
  llmMode: "tool" | "json";
  /** Agentic loop: when true, the chat turn runs the durable tool-loop
   *  (read-then-act + resume across the confirm round-trip). Default ON after the
   *  live acceptance proof; set LLM_AGENTIC=0 to roll back to single-turn. */
  llmAgentic: boolean;
  /** Tool subsetting: when true, each chat turn (and its resume) shows the model only
   *  the actions relevant to the message (+ an always-on core) instead of all 140, for
   *  weak-model consistency. Default ON after the agentic eval proved it (DeepSeek 100%
   *  held, ~61% fewer prompt tokens/turn, 0 safety); LLM_TOOL_SELECT=0 is the rollback.
   *  No-match/non-ASCII/>3-area inputs fail open to the full catalog. The harness still
   *  validates + gates every proposed action. */
  llmToolSelect: boolean;
  llmBaseUrl?: string;
  /** Secret-free hash of the normalized provider base, exposed in release
   * evidence so a DeepSeek-labeled run cannot silently target another host. */
  llmEndpointSha256?: string;
  llmApiKey?: string;
  llmModel?: string;
  /** Per-request model timeout (ms); the HTTP client defaults to 120s when unset. */
  llmTimeoutMs?: number;
  /** Clockify commit/IO timeout (ms); defaults to 120000. Must stay < CLAIM_TTL_MS (300000). */
  commitTimeoutMs?: number;
  /** Retention window (days) for chat transcripts + the audit log; defaults to 90. Floor 30. */
  retentionDays?: number;
  /** Provider thinking control passed through as reasoning_effort. */
  llmReasoningEffort?: string;
  /** Optional OpenAI-compatible thinking toggle. Omitted by default so existing
   *  provider request bodies remain byte-compatible. DeepSeek V4 accepts both. */
  llmThinkingMode?: "enabled" | "disabled";
  /** Optional sampling seed (OpenAI-compatible `seed`) for run-to-run reproducibility
   *  on weak models. Unset ⇒ not sent (byte-identical). */
  llmSeed?: number;
  /** Optional Gemini model for the gemini-cli provider (else the CLI router picks). */
  geminiModel?: string;
  /** Chat rate limit per admin session; the route defaults apply when unset. */
  chatRateLimitMax?: number;
  chatRateLimitWindowMs?: number;
  /** New-chat (session-creation) rate limit per ADMIN; bounds minting fresh sessions
   *  to reset the per-session paid-loop budget. Route defaults apply when unset. */
  newChatRateLimitMax?: number;
  newChatRateLimitWindowMs?: number;
  /** Broad authenticated API budget per workspace/admin. This is intentionally
   *  separate from the tighter paid-model-loop and new-chat budgets. */
  apiRateLimitMax?: number;
  apiRateLimitWindowMs?: number;
}

const envObjectSchema = z.object({
  NODE_ENV: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive(),
  BASE_URL: z.string().min(1),
  PUBLIC_CONTACT_URL: z.string().min(1).refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "https:" || protocol === "mailto:";
    } catch {
      return false;
    }
  }, "PUBLIC_CONTACT_URL must be an absolute HTTPS or mailto URL").optional(),
  RELEASE_SHA: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).optional(),
  RELEASE_BUILD_HASH: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  RELEASE_SOURCE_BINDING_SHA256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  CLOCKIFY_ADDON_PUBLIC_KEY_PEM: z.string().min(1).optional(),
  CLOCKIFY_ADDON_KEY: z.string().min(1),
  // Keys both the signed session cookie (forgery resistance) AND the confirmation
  // nonce hash (src/harness/confirmations.ts). A weak value silently weakens both, so
  // require real entropy and fail closed — matching DATA_ENCRYPTION_KEY's floor.
  SESSION_SECRET: z.string().min(32),
  /** Signed-session lifetime in HOURS. Default 2h; min 0.1 (6 min) so a typo can't
   *  mint an effectively-zero session. Current role is checked independently. */
  SESSION_TTL_HOURS: z.coerce.number().positive().min(0.1).optional(),
  // Deprecated compatibility input. Rechecking is mandatory regardless of value.
  ROLE_RECHECK: z.enum(["0", "1"]).default("0"),
  ROLE_RECHECK_TTL_MS: z.coerce.number().int().positive().max(60_000).optional(),
  // A passphrase, SHA-256-derived to the AES-256-GCM key (src/db/encryption.ts);
  // NOT raw hex bytes. Require real entropy (>=32 chars), not a 1-char value.
  DATA_ENCRYPTION_KEY: z.string().min(32).optional(),
  DATA_ENCRYPTION_KEY_PREVIOUS: z.string().min(32).optional(),
  DATABASE_PATH: z.string().min(1),
  // F24: the deploy transaction's recorded claim about DATABASE_PATH. When
  // `new_unused`, startup proves the path is genuinely fresh before boot
  // (src/db/fresh-boundary.ts). Absent = no boundary claim (dev/tests).
  DATABASE_PATH_DISPOSITION: z.enum(["new_unused", "existing_expected"]).optional(),
  // The HTTP provider needs base/key/model; the gemini-cli provider needs none
  // (it uses the authenticated CLI), so these are optional here and enforced
  // below only for the http provider.
  LLM_PROVIDER: z.enum(["http", "gemini-cli"]).default("http"),
  // C11 (owner decision 2026-07-31): the default is v2. Production already
  // selects v2 explicitly, so this changes only what an UNSPECIFIED
  // configuration does. `ASSISTANT_ENGINE=v1` remains the tested rollback and
  // the enum stays two-valued — narrowing it is the LAST step of v1
  // retirement (see docs/V1_RETIREMENT_SEQUENCE.md), never a side effect here.
  ASSISTANT_ENGINE: z.enum(["v1", "v2"]).default("v2"),
  LLM_MODE: z.enum(["tool", "json"]).default("tool"),
  // Default ON: the durable agentic loop is the proven default (live PASS=10,
  // adversarial review all-HELD). LLM_AGENTIC=0 is the instant rollback.
  LLM_AGENTIC: z.enum(["0", "1"]).default("1"),
  // Default ON: deterministic tool subsetting (weak-model consistency). The agentic
  // eval proved it on the default backend — DeepSeek held 100% pass / 0 safety OFF
  // and ON over 11 cases × 5, with ~61% fewer prompt tokens/turn (18.7K→7.1K per
  // round-trip) and latency down; no case regressed. =0 is the instant rollback,
  // byte-identical to showing the full catalog.
  LLM_TOOL_SELECT: z.enum(["0", "1"]).default("1"),
  LLM_BASE_URL: z.string().min(1).optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_MODEL: z.string().min(1).optional(),
  /** Per-request model timeout (ms); the client defaults to 120s when unset. */
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  /** Clockify commit/IO timeout (ms). Must be < 290000 (strictly below CLAIM_TTL_MS=300000). */
  COMMIT_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  /** Retention (days) for chat_messages + audit_events. Min 30 so the 30-day metrics
   *  default never silently truncates; defaults to 90 in the store when unset. */
  RETENTION_DAYS: z.coerce.number().int().min(30).optional(),
  /** Provider thinking control (e.g. "none" disables Gemini thinking). */
  LLM_REASONING_EFFORT: z.string().min(1).optional(),
  /** Provider thinking toggle (DeepSeek V4/OpenAI-compatible extension). */
  LLM_THINKING_MODE: z.enum(["enabled", "disabled"]).optional(),
  /** Optional sampling seed (OpenAI-compatible `seed`) for reproducible weak-model runs. */
  LLM_SEED: z.coerce.number().int().optional(),
  GEMINI_MODEL: z.string().min(1).optional(),
  /** Chat rate limit per admin session (each turn drives a paid model loop). */
  CHAT_RATE_LIMIT_MAX: z.coerce.number().int().positive().optional(),
  CHAT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().optional(),
  /** New-chat (session-creation) rate limit per admin — bounds resetting the
   *  per-session paid-loop budget by minting fresh sessions. */
  NEW_CHAT_RATE_LIMIT_MAX: z.coerce.number().int().positive().optional(),
  NEW_CHAT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().optional(),
  /** Broad authenticated API rate limit. Keep the knobs finite so an operator
   *  cannot accidentally disable the security boundary with an extreme value. */
  API_RATE_LIMIT_MAX: z.coerce.number().int().positive().max(10_000).optional(),
  API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(60 * 60 * 1000).optional(),
});

const envSchema = envObjectSchema.superRefine((v, ctx) => {
  if (v.LLM_PROVIDER === "http") {
    for (const key of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"] as const) {
      if (!v[key]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${key} is required when LLM_PROVIDER=http`, path: [key] });
      }
    }
  }
  if (v.NODE_ENV === "production") {
    try {
      assertProductionDeepSeekConfiguration({
        provider: v.LLM_PROVIDER,
        baseUrl: v.LLM_BASE_URL,
        model: v.LLM_MODEL,
      });
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "Invalid production DeepSeek configuration",
        path: ["LLM_BASE_URL"],
      });
    }
  }
  if (v.COMMIT_TIMEOUT_MS !== undefined && v.COMMIT_TIMEOUT_MS >= 290_000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["COMMIT_TIMEOUT_MS"],
      message:
        "COMMIT_TIMEOUT_MS must be < 290000ms — it has to stay strictly below the idempotency CLAIM_TTL_MS (300000ms, src/db/store.ts) so a slow live commit's claim is never swept.",
    });
  }
  if ((v.RELEASE_SHA === undefined) !== (v.RELEASE_BUILD_HASH === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [v.RELEASE_SHA === undefined ? "RELEASE_SHA" : "RELEASE_BUILD_HASH"],
      message: "RELEASE_SHA and RELEASE_BUILD_HASH must be set together",
    });
  }
  if (v.RELEASE_SOURCE_BINDING_SHA256 !== undefined && v.RELEASE_SHA === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["RELEASE_SOURCE_BINDING_SHA256"],
      message: "RELEASE_SOURCE_BINDING_SHA256 requires RELEASE_SHA and RELEASE_BUILD_HASH",
    });
  }
});

/**
 * Every environment variable the schema accepts. `.env.example` must document
 * each one (required values uncommented, optional knobs as commented entries) so
 * the README's "full list" claim stays true; a unit test pins this (no schema
 * key may silently skip the template).
 */
export const ENV_SCHEMA_KEYS: readonly string[] = Object.keys(envObjectSchema.shape);

/**
 * Attach the offending VARIABLE NAMES to a validation failure, on the
 * declared-safe channel `classifyLoggableError` reads.
 *
 * A boot failure is logged as a bounded classification, so `startup failed:
 * name=ZodError` alone would leave an operator with nothing actionable. The
 * issue `path` is the schema's own key — `SESSION_SECRET`, `LLM_PROVIDER` —
 * and is therefore safe to name, whereas the message beside it is not: a
 * `too_small` issue reports only a length bound, but an `invalid_enum_value`
 * issue echoes the REJECTED VALUE verbatim, and this schema reads secrets
 * (`SESSION_SECRET`, `DATA_ENCRYPTION_KEY`, `LLM_API_KEY`) out of the same
 * object. Paths, not messages, is the line that keeps both properties.
 *
 * The original error is rethrown UNCHANGED apart from the added property, so
 * the thrown message an operator sees interactively (and every `.toThrow(/…/)`
 * assertion in tests/unit/config.test.ts) is untouched.
 */
function withLogSafeIssuePaths(error: unknown): unknown {
  if (!(error instanceof z.ZodError)) return error;
  const paths = [...new Set(error.issues.map((issue) => issue.path.join(".")).filter((path) => path.length > 0))];
  if (paths.length === 0) return error;
  return Object.assign(error, { logSafeDetail: paths.join(",") });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  let parsed: z.infer<typeof envSchema>;
  try {
    parsed = envSchema.parse(env);
  } catch (error) {
    throw withLogSafeIssuePaths(error);
  }
  const nodeEnv = parsed.NODE_ENV ?? "development";

  if (nodeEnv !== "test" && !parsed.DATA_ENCRYPTION_KEY) {
    throw Object.assign(
      new Error(
        "DATA_ENCRYPTION_KEY is required outside NODE_ENV=test (installation tokens must not be stored in plaintext).",
      ),
      // Same channel: this check is outside the schema, so it names its own key.
      { logSafeDetail: "DATA_ENCRYPTION_KEY" },
    );
  }

  return {
    nodeEnv,
    port: parsed.PORT,
    baseUrl: parsed.BASE_URL,
    publicContactUrl: parsed.PUBLIC_CONTACT_URL,
    releaseSha: parsed.RELEASE_SHA,
    releaseBuildHash: parsed.RELEASE_BUILD_HASH,
    releaseSourceBindingSha256: parsed.RELEASE_SOURCE_BINDING_SHA256,
    // Clockify signs every add-on token with one platform-wide key. Default to
    // the built-in key so install/lifecycle verification works out of the box;
    // the env var only overrides it for other Clockify environments/regions.
    clockifyAddonPublicKeyPem:
      parsed.CLOCKIFY_ADDON_PUBLIC_KEY_PEM ?? CLOCKIFY_PLATFORM_PUBLIC_KEY_PEM,
    clockifyAddonKey: parsed.CLOCKIFY_ADDON_KEY,
    sessionSecret: parsed.SESSION_SECRET,
    // Default 2h; operators can raise it for a longer history window. Current-role
    // checks remain mandatory and independent of this cookie lifetime.
    sessionTtlMs: (parsed.SESSION_TTL_HOURS ?? 2) * 60 * 60 * 1000,
    roleRecheckEnabled: true,
    roleRecheckTtlMs: parsed.ROLE_RECHECK_TTL_MS ?? 60_000,
    dataEncryptionKey: parsed.DATA_ENCRYPTION_KEY,
    dataEncryptionKeyPrevious: parsed.DATA_ENCRYPTION_KEY_PREVIOUS,
    databasePath: parsed.DATABASE_PATH,
    databasePathDisposition: parsed.DATABASE_PATH_DISPOSITION,
    llmProvider: parsed.LLM_PROVIDER,
    assistantEngine: parsed.ASSISTANT_ENGINE,
    llmMode: parsed.LLM_MODE,
    llmAgentic: parsed.LLM_AGENTIC === "1",
    llmToolSelect: parsed.LLM_TOOL_SELECT === "1",
    llmBaseUrl: parsed.LLM_BASE_URL,
    llmEndpointSha256: parsed.LLM_BASE_URL === undefined
      ? undefined
      : modelEndpointSha256(parsed.LLM_BASE_URL),
    llmApiKey: parsed.LLM_API_KEY,
    llmModel: parsed.LLM_MODEL,
    llmTimeoutMs: parsed.LLM_TIMEOUT_MS,
    commitTimeoutMs: parsed.COMMIT_TIMEOUT_MS,
    retentionDays: parsed.RETENTION_DAYS,
    llmReasoningEffort: parsed.LLM_REASONING_EFFORT,
    llmThinkingMode: parsed.LLM_THINKING_MODE,
    llmSeed: parsed.LLM_SEED,
    geminiModel: parsed.GEMINI_MODEL,
    chatRateLimitMax: parsed.CHAT_RATE_LIMIT_MAX,
    chatRateLimitWindowMs: parsed.CHAT_RATE_LIMIT_WINDOW_MS,
    newChatRateLimitMax: parsed.NEW_CHAT_RATE_LIMIT_MAX,
    newChatRateLimitWindowMs: parsed.NEW_CHAT_RATE_LIMIT_WINDOW_MS,
    apiRateLimitMax: parsed.API_RATE_LIMIT_MAX,
    apiRateLimitWindowMs: parsed.API_RATE_LIMIT_WINDOW_MS,
  };
}
