import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { CLOCKIFY_PLATFORM_PUBLIC_KEY_PEM } from "../../src/addon/clockify-public-key.js";

const baseEnv = {
  PORT: "3001",
  BASE_URL: "https://example.com/addon",
  CLOCKIFY_ADDON_PUBLIC_KEY_PEM: "public-key",
  CLOCKIFY_ADDON_KEY: "ai-assistant",
  SESSION_SECRET: "session-secret-with-32-chars-of-entropy",
  DATABASE_PATH: ":memory:",
  LLM_BASE_URL: "https://api.deepseek.com",
  LLM_API_KEY: "llm-key",
  LLM_MODEL: "deepseek-v4-pro",
};

describe("loadConfig", () => {
  it("rejects a SESSION_SECRET below 32 chars (cookie-forgery + nonce-hash strength)", () => {
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: "test", SESSION_SECRET: "too-short" })).toThrow();
  });

  it("loads required config", () => {
    const cfg = loadConfig({
      ...baseEnv,
      DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    });
    expect(cfg.port).toBe(3001);
    expect(cfg.databasePath).toBe(":memory:");
    expect(cfg.baseUrl).toBe("https://example.com/addon");
    expect(cfg.clockifyAddonKey).toBe("ai-assistant");
    expect(cfg.clockifyAddonPublicKeyPem).toBe("public-key");
    expect(cfg.llmBaseUrl).toBe("https://api.deepseek.com");
    expect(cfg.llmApiKey).toBe("llm-key");
    expect(cfg.llmModel).toBe("deepseek-v4-pro");
  });

  it("defaults ASSISTANT_ENGINE to v2, accepts exact engines, and rejects other values", () => {
    const base = { ...baseEnv, DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" };
    // C11: "absent" and "explicit v1" were the SAME assertion while the default
    // was v1. They are two different claims now, so both arms are pinned — the
    // new default, and the rollback that must keep working.
    expect(loadConfig(base).assistantEngine).toBe("v2");
    expect(loadConfig({ ...base, ASSISTANT_ENGINE: "v1" }).assistantEngine).toBe("v1");
    expect(loadConfig({ ...base, ASSISTANT_ENGINE: "v2" }).assistantEngine).toBe("v2");
    expect(() => loadConfig({ ...base, ASSISTANT_ENGINE: "V1" })).toThrow();
    expect(() => loadConfig({ ...base, ASSISTANT_ENGINE: "legacy" })).toThrow();
  });

  it("binds production HTTP model traffic to the approved DeepSeek endpoint and model", () => {
    const production = {
      ...baseEnv,
      NODE_ENV: "production",
      DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    };
    expect(loadConfig(production)).toMatchObject({
      llmProvider: "http",
      llmBaseUrl: "https://api.deepseek.com",
      llmModel: "deepseek-v4-pro",
    });
    expect(loadConfig({ ...production, LLM_BASE_URL: "https://api.deepseek.com/v1/" }).llmBaseUrl)
      .toBe("https://api.deepseek.com/v1/");
    for (const untrusted of [
      "http://api.deepseek.com",
      "https://deepseek.example.com",
      "https://api.deepseek.com.evil.example",
      "https://user:pass@api.deepseek.com",
      "https://api.deepseek.com/v2",
      "https://api.deepseek.com/v1?redirect=1",
      "https://api.deepseek.com/v1#fragment",
    ] as const) {
      expect(() => loadConfig({ ...production, LLM_BASE_URL: untrusted })).toThrow(/DeepSeek/u);
    }
    expect(() => loadConfig({ ...production, LLM_MODEL: "another-model" })).toThrow(/DeepSeek/u);
    expect(() => loadConfig({ ...production, LLM_PROVIDER: "gemini-cli" })).toThrow(/DeepSeek/u);
  });

  it("accepts only HTTPS or mailto public contact destinations", () => {
    const base = { ...baseEnv, DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" };
    expect(loadConfig({ ...base, PUBLIC_CONTACT_URL: "mailto:support@example.com" }).publicContactUrl)
      .toBe("mailto:support@example.com");
    expect(loadConfig({ ...base, PUBLIC_CONTACT_URL: "https://support.example.com/form" }).publicContactUrl)
      .toBe("https://support.example.com/form");
    expect(() => loadConfig({ ...base, PUBLIC_CONTACT_URL: "javascript:alert(1)" })).toThrow(/PUBLIC_CONTACT_URL/);
    expect(() => loadConfig({ ...base, PUBLIC_CONTACT_URL: "/relative" })).toThrow(/PUBLIC_CONTACT_URL/);
  });

  it("validates immutable release identity metadata", () => {
    const base = { ...baseEnv, DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" };
    const releaseSha = "a".repeat(40);
    const buildHash = "b".repeat(64);
    const sourceBindingSha256 = "c".repeat(64);
    expect(loadConfig({
      ...base,
      RELEASE_SHA: releaseSha,
      RELEASE_BUILD_HASH: buildHash,
      RELEASE_SOURCE_BINDING_SHA256: sourceBindingSha256,
    })).toMatchObject({
      releaseSha,
      releaseBuildHash: buildHash,
      releaseSourceBindingSha256: sourceBindingSha256,
    });
    expect(() => loadConfig({ ...base, RELEASE_SHA: "main" })).toThrow();
    expect(() => loadConfig({ ...base, RELEASE_BUILD_HASH: "short" })).toThrow();
    expect(() => loadConfig({ ...base, RELEASE_SOURCE_BINDING_SHA256: sourceBindingSha256 })).toThrow();
  });

  it("defaults llmMode to tool and honors LLM_MODE=json", () => {
    const base = { ...baseEnv, DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" };
    expect(loadConfig(base).llmMode).toBe("tool");
    expect(loadConfig({ ...base, LLM_MODE: "json" }).llmMode).toBe("json");
  });

  it("defaults llmAgentic ON (post live-proof flip) and honors LLM_AGENTIC=0 for rollback", () => {
    const base = { ...baseEnv, DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" };
    expect(loadConfig(base).llmAgentic).toBe(true);
    expect(loadConfig({ ...base, LLM_AGENTIC: "1" }).llmAgentic).toBe(true);
    expect(loadConfig({ ...base, LLM_AGENTIC: "0" }).llmAgentic).toBe(false);
  });

  it("defaults sessionTtlMs to 2h (authz-surface-01 staleness bound) and honors SESSION_TTL_HOURS", () => {
    const base = { ...baseEnv, DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" };
    expect(loadConfig(base).sessionTtlMs).toBe(2 * 60 * 60 * 1000);
    expect(loadConfig({ ...base, SESSION_TTL_HOURS: "1" }).sessionTtlMs).toBe(60 * 60 * 1000);
    expect(loadConfig({ ...base, SESSION_TTL_HOURS: "8" }).sessionTtlMs).toBe(8 * 60 * 60 * 1000);
    expect(() => loadConfig({ ...base, SESSION_TTL_HOURS: "0" })).toThrow(); // below the 0.1h floor
  });

  it("defaults llmToolSelect ON (post-eval flip: DeepSeek 100% held, -61% prompt tokens, 0 safety) and honors LLM_TOOL_SELECT=0 for rollback", () => {
    const base = { ...baseEnv, DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" };
    expect(loadConfig(base).llmToolSelect).toBe(true);
    expect(loadConfig({ ...base, LLM_TOOL_SELECT: "1" }).llmToolSelect).toBe(true);
    expect(loadConfig({ ...base, LLM_TOOL_SELECT: "0" }).llmToolSelect).toBe(false);
  });

  it("parses LLM_TIMEOUT_MS to a number and leaves it undefined when absent (client default applies)", () => {
    const base = { ...baseEnv, DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" };
    expect(loadConfig(base).llmTimeoutMs).toBeUndefined();
    expect(loadConfig({ ...base, LLM_TIMEOUT_MS: "60000" }).llmTimeoutMs).toBe(60000);
    expect(() => loadConfig({ ...base, LLM_TIMEOUT_MS: "not-a-number" })).toThrow();
  });

  it("validates the optional provider thinking-mode toggle and omits it by default", () => {
    const base = { ...baseEnv, DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" };
    expect(loadConfig(base).llmThinkingMode).toBeUndefined();
    expect(loadConfig({ ...base, LLM_THINKING_MODE: "disabled" }).llmThinkingMode).toBe("disabled");
    expect(loadConfig({ ...base, LLM_THINKING_MODE: "enabled" }).llmThinkingMode).toBe("enabled");
    expect(() => loadConfig({ ...base, LLM_THINKING_MODE: "none" })).toThrow();
  });

  it("parses COMMIT_TIMEOUT_MS, leaves it undefined when absent (adapter default applies), and bounds it below CLAIM_TTL_MS", () => {
    const base = { ...baseEnv, DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" };
    // Unset → undefined so the REST adapter's COMMIT_TIMEOUT_MS default applies.
    expect(loadConfig(base).commitTimeoutMs).toBeUndefined();
    // A valid override is coerced to a number.
    expect(loadConfig({ ...base, COMMIT_TIMEOUT_MS: "60000" }).commitTimeoutMs).toBe(60000);
    // At/above the safety upper bound it must fail at startup: a commit slower than
    // the idempotency claim TTL (300000ms) could have its live claim swept → double-commit.
    expect(() => loadConfig({ ...base, COMMIT_TIMEOUT_MS: "290000" })).toThrow(/CLAIM_TTL_MS/);
    expect(() => loadConfig({ ...base, COMMIT_TIMEOUT_MS: "400000" })).toThrow(/CLAIM_TTL_MS/);
    // Non-positive / non-integer values are rejected by the schema.
    expect(() => loadConfig({ ...base, COMMIT_TIMEOUT_MS: "0" })).toThrow();
    expect(() => loadConfig({ ...base, COMMIT_TIMEOUT_MS: "not-a-number" })).toThrow();
  });

  it("parses RETENTION_DAYS, leaves it undefined when absent (store default 90 applies), and enforces the >=30 floor", () => {
    const base = { ...baseEnv, DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" };
    expect(loadConfig(base).retentionDays).toBeUndefined();
    expect(loadConfig({ ...base, RETENTION_DAYS: "120" }).retentionDays).toBe(120);
    // Below the floor: the 30-day metrics default must never silently truncate.
    expect(() => loadConfig({ ...base, RETENTION_DAYS: "10" })).toThrow();
  });

  it("parses the authenticated API rate-limit overrides and rejects invalid bounds", () => {
    const base = { ...baseEnv, DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" };
    expect(loadConfig(base).apiRateLimitMax).toBeUndefined();
    expect(loadConfig(base).apiRateLimitWindowMs).toBeUndefined();
    expect(loadConfig({
      ...base,
      API_RATE_LIMIT_MAX: "750",
      API_RATE_LIMIT_WINDOW_MS: "120000",
    })).toMatchObject({
      apiRateLimitMax: 750,
      apiRateLimitWindowMs: 120_000,
    });
    expect(() => loadConfig({ ...base, API_RATE_LIMIT_MAX: "0" })).toThrow();
    expect(() => loadConfig({ ...base, API_RATE_LIMIT_MAX: "10001" })).toThrow();
    expect(() => loadConfig({ ...base, API_RATE_LIMIT_WINDOW_MS: "999" })).toThrow();
    expect(() => loadConfig({ ...base, API_RATE_LIMIT_WINDOW_MS: "3600001" })).toThrow();
    expect(() => loadConfig({ ...base, API_RATE_LIMIT_WINDOW_MS: "not-a-number" })).toThrow();
  });

  it("rejects production without data encryption key", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        ...baseEnv,
      }),
    ).toThrow("DATA_ENCRYPTION_KEY");
  });

  it("allows test environment without data encryption key", () => {
    const cfg = loadConfig({ NODE_ENV: "test", ...baseEnv });
    expect(cfg.dataEncryptionKey).toBeUndefined();
    expect(cfg.nodeEnv).toBe("test");
  });

  it("rejects a too-short DATA_ENCRYPTION_KEY but accepts a >=32-char passphrase", () => {
    // The key is a passphrase SHA-256-derived to 32 bytes (src/db/encryption.ts);
    // a 1-char value was previously accepted. Require real entropy (>=32 chars).
    expect(() =>
      loadConfig({ NODE_ENV: "production", ...baseEnv, DATA_ENCRYPTION_KEY: "tooshort" }),
    ).toThrow();
    const cfg = loadConfig({
      NODE_ENV: "production",
      ...baseEnv,
      DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef", // 32 chars
    });
    expect(cfg.dataEncryptionKey).toBe("0123456789abcdef0123456789abcdef");
  });

  it("accepts a strong previous data-encryption key for online token rotation", () => {
    const cfg = loadConfig({
      NODE_ENV: "production",
      ...baseEnv,
      DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      DATA_ENCRYPTION_KEY_PREVIOUS: "fedcba9876543210fedcba9876543210",
    });
    expect(cfg.dataEncryptionKeyPrevious).toBe("fedcba9876543210fedcba9876543210");
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...baseEnv,
      DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      DATA_ENCRYPTION_KEY_PREVIOUS: "short",
    })).toThrow();
  });

  it("rejects missing required env", () => {
    expect(() => loadConfig({ PORT: "3001" })).toThrow();
  });

  it("defaults the Clockify public key to the built-in platform key", () => {
    const { CLOCKIFY_ADDON_PUBLIC_KEY_PEM: _omit, ...withoutPem } = baseEnv;
    const cfg = loadConfig({ NODE_ENV: "test", ...withoutPem });
    expect(cfg.clockifyAddonPublicKeyPem).toBe(CLOCKIFY_PLATFORM_PUBLIC_KEY_PEM);
  });

  it("lets the env override the built-in public key", () => {
    const cfg = loadConfig({ NODE_ENV: "test", ...baseEnv });
    expect(cfg.clockifyAddonPublicKeyPem).toBe("public-key");
  });

  it("defaults the LLM provider to http and keeps requiring the LLM_* envs", () => {
    const cfg = loadConfig({ NODE_ENV: "test", ...baseEnv });
    expect(cfg.llmProvider).toBe("http");
    const { LLM_API_KEY: _k, ...withoutKey } = baseEnv;
    expect(() => loadConfig({ NODE_ENV: "test", ...withoutKey })).toThrow();
  });

  it("rejects a positive role-cache window longer than 60 seconds", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      ...baseEnv,
      ROLE_RECHECK_TTL_MS: "60001",
    })).toThrow();
  });

  it("allows the gemini-cli provider without an LLM base url or api key", () => {
    const { LLM_BASE_URL: _b, LLM_API_KEY: _k, LLM_MODEL: _m, ...minimal } = baseEnv;
    const cfg = loadConfig({ NODE_ENV: "test", ...minimal, LLM_PROVIDER: "gemini-cli", GEMINI_MODEL: "gemini-2.5-flash" });
    expect(cfg.llmProvider).toBe("gemini-cli");
    expect(cfg.geminiModel).toBe("gemini-2.5-flash");
  });
});
