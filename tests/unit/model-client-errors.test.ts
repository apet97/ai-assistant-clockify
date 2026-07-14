import { describe, expect, it, vi } from "vitest";
import { createModelClient } from "../../src/assistant/model-client.js";

describe("model provider errors are log-safe", () => {
  it("logs only category, status, and provider request id", async () => {
    const secretBody = "prompt=private customer data Authorization=Bearer top-secret tool_result=confidential";
    const fetchImpl = vi.fn(async () => new Response(secretBody, {
      status: 400,
      headers: { "x-request-id": "provider-req-123" },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = createModelClient({
      baseUrl: "https://llm.example.com",
      apiKey: "top-secret",
      model: "model",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error = await client.complete([{ role: "user", content: "private customer data" }]).catch((caught: unknown) => caught);
    const combined = `${String(error)} ${warn.mock.calls.flat().join(" ")}`;
    expect(combined).toContain("provider_http_error");
    expect(combined).toContain("status=400");
    expect(combined).toContain("request_id=provider-req-123");
    expect(combined).not.toContain("private customer data");
    expect(combined).not.toContain("top-secret");
    expect(combined).not.toContain("confidential");
    warn.mockRestore();
  });

  it("does not echo a malformed success body", async () => {
    const fetchImpl = vi.fn(async () => new Response("private malformed output", {
      status: 200,
      headers: { "x-request-id": "provider-req-456" },
    }));
    const client = createModelClient({
      baseUrl: "https://llm.example.com",
      apiKey: "top-secret",
      model: "model",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const error = await client.complete([{ role: "user", content: "private prompt" }]).catch((caught: unknown) => caught);
    expect(String(error)).toContain("provider_malformed_response");
    expect(String(error)).toContain("request_id=provider-req-456");
    expect(String(error)).not.toContain("private malformed output");
  });
});
