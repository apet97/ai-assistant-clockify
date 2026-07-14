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
export type CliRunner = (args: string[], prompt: string, signal?: AbortSignal) => Promise<CliRunResult>;

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

/** Spawn-backed runner exported for deterministic process-lifecycle tests. Abort
 * sends one kill and settles only on `close`, so the child is reaped exactly once. */
export function createGeminiCliRunner(
  bin: string,
  timeoutMs: number,
  spawnImpl: typeof spawn = spawn,
): CliRunner {
  return (args, prompt, signal) =>
    new Promise<CliRunResult>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("gemini CLI aborted by caller"));
        return;
      }
      // No shell: argv array, so prompt content can never be interpreted as a command.
      const child = spawnImpl(
        bin,
        [...args, "-p", prompt],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      let terminalError: Error | undefined;
      let killSent = false;
      let settled = false;
      const requestStop = (error: Error): void => {
        terminalError ??= error;
        if (killSent) return;
        killSent = true;
        child.kill("SIGKILL");
      };
      const onAbort = (): void => requestStop(new Error("gemini CLI aborted by caller"));
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(
        () => requestStop(new Error(`gemini CLI timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("error", (err) => {
        if (terminalError || settled) return;
        settled = true;
        cleanup();
        reject(err);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (terminalError) reject(terminalError);
        else resolve({ code: code ?? 0, stdout, stderr });
      });
    });
}

export function createGeminiCliModelClient(config: GeminiCliConfig = {}): ModelClient {
  const bin = config.bin ?? "gemini";
  const timeoutMs = config.timeoutMs ?? 90_000;
  const run = config.run ?? createGeminiCliRunner(bin, timeoutMs);

  return {
    async complete(messages: ModelMessage[], _onUsage, signal): Promise<string> {
      const args = ["-o", "json", ...(config.model ? ["-m", config.model] : [])];
      const result = await run(args, flattenMessages(messages), signal);
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
