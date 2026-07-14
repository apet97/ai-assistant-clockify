import { spawn } from "node:child_process";
import type { ModelClient, ModelMessage } from "./model-client.js";

/**
 * Dev-only model adapter backed by the authenticated `gemini` CLI (no API key) —
 * a selectable alternative to the HTTP OpenAI-compatible client. It runs the CLI
 * headlessly in JSON-output mode (`gemini -o json -p <prompt>`) and returns the
 * model's text from the `.response` field of the CLI envelope; the planner owns
 * JSON validation and the single repair attempt, exactly as with the HTTP client.
 *
 * No secret is involved (the CLI carries its own OAuth session). The prompt is
 * passed as an argv element (never through a shell), so workspace/user content
 * cannot inject shell commands. stderr (CLI warnings) is discarded so stdout is a
 * clean JSON envelope. This is intended for live dev/testing, not production.
 */
export interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable for tests; given the CLI args and the prompt, runs it and captures output. */
export type CliRunner = (args: string[], prompt: string) => Promise<CliRunResult>;

export interface GeminiCliConfig {
  /** Pin a Gemini model (passed as `-m`); when omitted the CLI router chooses. */
  model?: string;
  /** Path/name of the gemini binary (default "gemini"). */
  bin?: string;
  /** Abort the CLI call after this many ms (default 90s). */
  timeoutMs?: number;
  /** Injectable runner for tests; defaults to spawning the CLI. */
  run?: CliRunner;
}

interface GeminiJsonEnvelope {
  response?: string;
}

/** System content carries the instructions; the rest is rendered as a transcript. */
function flattenMessages(messages: ModelMessage[]): string {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const convo = messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
    .join("\n");
  return [system, convo ? `Conversation so far:\n${convo}` : "", "Respond now with only the required JSON object."]
    .filter(Boolean)
    .join("\n\n");
}

function spawnRunner(bin: string, timeoutMs: number): CliRunner {
  return (args, prompt) =>
    new Promise<CliRunResult>((resolve, reject) => {
      // No shell: argv array, so prompt content can never be interpreted as a command.
      const child = spawn(bin, [...args, "-p", prompt], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`gemini CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 0, stdout, stderr });
      });
    });
}

export function createGeminiCliModelClient(config: GeminiCliConfig = {}): ModelClient {
  const bin = config.bin ?? "gemini";
  const timeoutMs = config.timeoutMs ?? 90_000;
  const run = config.run ?? spawnRunner(bin, timeoutMs);

  return {
    async complete(messages: ModelMessage[]): Promise<string> {
      const args = ["-o", "json", ...(config.model ? ["-m", config.model] : [])];
      const result = await run(args, flattenMessages(messages));
      if (result.code !== 0) {
        throw new Error(`gemini_cli_exit code=${result.code}`);
      }
      let envelope: GeminiJsonEnvelope;
      try {
        envelope = JSON.parse(result.stdout) as GeminiJsonEnvelope;
      } catch {
        throw new Error("gemini_cli_malformed_response");
      }
      return envelope.response ?? "";
    },
  };
}
