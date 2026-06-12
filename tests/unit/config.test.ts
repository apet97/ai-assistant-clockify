import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { CLOCKIFY_PLATFORM_PUBLIC_KEY_PEM } from "../../src/addon/clockify-public-key.js";

const baseEnv = {
  PORT: "3001",
  BASE_URL: "https://example.com/addon",
  CLOCKIFY_ADDON_PUBLIC_KEY_PEM: "public-key",
  CLOCKIFY_ADDON_KEY: "ai-assistant",
  SESSION_SECRET: "session-secret",
  DATABASE_PATH: ":memory:",
  LLM_BASE_URL: "https://llm.example.com",
  LLM_API_KEY: "llm-key",
  LLM_MODEL: "cheap-model",
};

describe("loadConfig", () => {
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

  it("parses LLM_TIMEOUT_MS to a number and leaves it undefined when absent (client default applies)", () => {
    const base = { ...baseEnv, DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" };
    expect(loadConfig(base).llmTimeoutMs).toBeUndefined();
    expect(loadConfig({ ...base, LLM_TIMEOUT_MS: "60000" }).llmTimeoutMs).toBe(60000);
    expect(() => loadConfig({ ...base, LLM_TIMEOUT_MS: "not-a-number" })).toThrow();
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
