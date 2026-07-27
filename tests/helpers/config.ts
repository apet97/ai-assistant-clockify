import type { AppConfig } from "../../src/config.js";

/**
 * Build a complete in-memory AppConfig for integration tests. Supplies a default
 * for EVERY required field so test files don't carry inline literals that silently
 * drift when AppConfig gains a required field (#37). Pass `overrides` for per-test
 * bits — most callers must override clockifyAddonPublicKeyPem (the generated test
 * key) and clockifyAddonKey.
 */
export function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    port: 3990,
    baseUrl: "https://example.com/ai-assistant",
    clockifyAddonPublicKeyPem: "test-public-key-pem",
    clockifyAddonKey: "ai-assistant",
    sessionSecret: "test-session-secret",
    sessionTtlMs: 2 * 60 * 60 * 1000,
    databasePath: ":memory:",
    llmProvider: "http",
    assistantEngine: "v1",
    llmMode: "tool",
    llmAgentic: true,
    llmToolSelect: true,
    llmBaseUrl: "https://llm.example.com",
    llmApiKey: "llm-key",
    llmModel: "cheap-model",
    ...overrides,
  };
}
