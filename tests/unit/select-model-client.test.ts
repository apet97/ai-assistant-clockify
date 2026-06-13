import { describe, expect, it, vi } from "vitest";
import { selectModelClient } from "../../src/assistant/select-model-client.js";

describe("selectModelClient", () => {
  it("builds the HTTP client when provider is http and creds are present", () => {
    const client = selectModelClient({
      llmProvider: "http",
      llmBaseUrl: "https://example.test/v1",
      llmApiKey: "fake-key",
      llmModel: "test-model",
    });
    expect(typeof client.complete).toBe("function");
  });

  it("throws when provider is http but a credential is missing", () => {
    expect(() => selectModelClient({ llmProvider: "http", llmBaseUrl: "https://x/v1", llmModel: "m" })).toThrow();
    expect(() => selectModelClient({ llmProvider: "http" })).toThrow();
  });

  it("builds the gemini-cli client without HTTP creds (and does not spawn at construction)", () => {
    const client = selectModelClient({ llmProvider: "gemini-cli", geminiModel: "gemini-x" });
    expect(typeof client.complete).toBe("function");
  });

  it("accepts llmTimeoutMs and threads it to the HTTP client", () => {
    const client = selectModelClient({
      llmProvider: "http",
      llmBaseUrl: "https://example.test/v1",
      llmApiKey: "fake-key",
      llmModel: "test-model",
      llmTimeoutMs: 60_000,
    });
    expect(typeof client.complete).toBe("function");
  });

  it("threads llmTimeoutMs (and the model) into the gemini-cli client", () => {
    const geminiFactory = vi.fn(() => ({ complete: async () => "" }));
    selectModelClient(
      { llmProvider: "gemini-cli", geminiModel: "gemini-x", llmTimeoutMs: 45_000 },
      { createGeminiCli: geminiFactory },
    );
    expect(geminiFactory).toHaveBeenCalledWith({ model: "gemini-x", timeoutMs: 45_000 });
  });
});
