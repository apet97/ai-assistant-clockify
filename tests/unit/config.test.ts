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
  LLM_BASE_URL: "https://llm.example.com",
  LLM_API_KEY: "llm-key",
  LLM_MODEL: "cheap-model",
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
    expect(cfg.llmBaseUrl).toBe("https://llm.example.com");
    expect(cfg.llmApiKey).toBe("llm-key");
    expect(cfg.llmModel).toBe("cheap-model");
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

  it("allows the gemini-cli provider without an LLM base url or api key", () => {
    const { LLM_BASE_URL: _b, LLM_API_KEY: _k, LLM_MODEL: _m, ...minimal } = baseEnv;
    const cfg = loadConfig({ NODE_ENV: "test", ...minimal, LLM_PROVIDER: "gemini-cli", GEMINI_MODEL: "gemini-2.5-flash" });
    expect(cfg.llmProvider).toBe("gemini-cli");
    expect(cfg.geminiModel).toBe("gemini-2.5-flash");
  });
});
