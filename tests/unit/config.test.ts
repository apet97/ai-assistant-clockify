import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

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
});
