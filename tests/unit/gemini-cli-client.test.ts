import { describe, expect, it, vi } from "vitest";
import { createGeminiCliModelClient } from "../../src/assistant/gemini-cli-client.js";
import type { ModelMessage } from "../../src/assistant/model-client.js";

const messages: ModelMessage[] = [
  { role: "system", content: "You are an assistant. Reply with JSON only." },
  { role: "user", content: "start a timer" },
];

/** The gemini CLI `-o json` envelope: the model's text lives in `.response`. */
function envelope(response: string): string {
  return JSON.stringify({ session_id: "s1", response, stats: {} });
}

describe("gemini CLI model client", () => {
  it("flattens messages, invokes the CLI, and returns the .response text", async () => {
    const run = vi.fn(async (_args: string[], _prompt: string) => ({ code: 0, stdout: envelope('{"kind":"answer","text":"hi"}'), stderr: "Ripgrep not available" }));
    const client = createGeminiCliModelClient({ run });
    const out = await client.complete(messages);
    expect(out).toBe('{"kind":"answer","text":"hi"}');

    // The CLI is asked for JSON output and the prompt carries both messages.
    const [args, prompt] = run.mock.calls[0];
    expect(args).toContain("-o");
    expect(args).toContain("json");
    expect(prompt).toContain("start a timer");
    expect(prompt).toContain("Reply with JSON only");
  });

  it("passes -m only when a model is configured", async () => {
    const run = vi.fn(async (_args: string[], _prompt: string) => ({ code: 0, stdout: envelope("{}"), stderr: "" }));
    await createGeminiCliModelClient({ run, model: "gemini-2.5-flash" }).complete(messages);
    expect(run.mock.calls[0][0]).toContain("gemini-2.5-flash");

    const run2 = vi.fn(async (_args: string[], _prompt: string) => ({ code: 0, stdout: envelope("{}"), stderr: "" }));
    await createGeminiCliModelClient({ run: run2 }).complete(messages);
    expect(run2.mock.calls[0][0]).not.toContain("-m");
  });

  it("throws on a non-zero exit code", async () => {
    const run = vi.fn(async (_args: string[], _prompt: string) => ({ code: 1, stdout: "", stderr: "secret prompt and token" }));
    const error = await createGeminiCliModelClient({ run }).complete(messages).catch((caught: unknown) => caught);
    expect(String(error)).toContain("gemini_cli_exit");
    expect(String(error)).not.toContain("secret prompt");
    expect(String(error)).not.toContain("token");
  });

  it("throws when stdout is not a parseable CLI envelope", async () => {
    const run = vi.fn(async (_args: string[], _prompt: string) => ({ code: 0, stdout: "secret tool output", stderr: "" }));
    const error = await createGeminiCliModelClient({ run }).complete(messages).catch((caught: unknown) => caught);
    expect(String(error)).toContain("gemini_cli_malformed_response");
    expect(String(error)).not.toContain("secret tool output");
  });
});
