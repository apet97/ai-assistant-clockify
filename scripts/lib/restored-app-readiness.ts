import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  RestoreVerificationError,
  type ApplicationReadinessProof,
  type ShutdownVerificationProof,
} from "../../src/db/restore-verification.js";
import {
  ReleaseArtifactIdentityError,
  verifyBuiltReleaseArtifact,
} from "./release-artifact-identity.js";

export interface RestoredApplicationReadinessOptions {
  restoredPath: string;
  encryptionKey: string;
  previousEncryptionKey?: string;
  releaseSha: string;
  releaseBuildHash: string;
  /**
   * The engine the probe must boot. Unset defaults to `v1`, which is what the
   * probe silently did before -- so nothing in the release path ever proved a
   * v2 deployment boots against a real database file.
   */
  assistantEngine?: "v1" | "v2";
  timeoutMs?: number;
  now?: () => Date;
  monotonicNow?: () => number;
  fetchImpl?: typeof fetch;
}

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 12_000;
const RESTORE_PROBE_CHILD_ARG = "--restore-readiness-probe-child";
const RELEASE_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function exitPromise(child: ChildProcess): Promise<ExitResult> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function waitForProbePort(
  child: ChildProcess,
  exited: Promise<ExitResult>,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome: { port: number } | { error: RestoreVerificationError }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.port);
    };
    const onMessage = (message: unknown): void => {
      if (
        typeof message !== "object" || message === null || Array.isArray(message)
        || (message as Record<string, unknown>).type !== "restore_readiness_listening"
        || !Number.isSafeInteger((message as Record<string, unknown>).port)
        || ((message as Record<string, unknown>).port as number) <= 0
        || ((message as Record<string, unknown>).port as number) > 65_535
      ) {
        finish({ error: new RestoreVerificationError("application_readiness", "invalid_listen_message") });
        return;
      }
      finish({ port: (message as { port: number }).port });
    };
    const onError = (): void => {
      finish({ error: new RestoreVerificationError("application_readiness", "startup_spawn_failed") });
    };
    const timer = setTimeout(() => {
      finish({ error: new RestoreVerificationError("application_readiness", "readiness_timeout") });
    }, timeoutMs);
    timer.unref?.();
    child.on("message", onMessage);
    child.once("error", onError);
    void exited.then(() => {
      finish({ error: new RestoreVerificationError("application_readiness", "startup_exited") });
    });
  });
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stopOneOffInstance(child: ChildProcess, exited: Promise<ExitResult>): Promise<ExitResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    const result = await within(exited, 1);
    if (!result || result.code !== 0) {
      throw new RestoreVerificationError("application_readiness", "startup_exited");
    }
    return result;
  }
  if (!child.kill("SIGTERM")) {
    throw new RestoreVerificationError("application_readiness", "shutdown_failed");
  }
  const result = await within(exited, SHUTDOWN_TIMEOUT_MS);
  if (!result) {
    child.kill("SIGKILL");
    await within(exited, 1_000);
    throw new RestoreVerificationError("application_readiness", "shutdown_timeout");
  }
  if (result.code !== 0) {
    throw new RestoreVerificationError("application_readiness", "shutdown_failed");
  }
  return result;
}

function verifyStoppedDatabase(path: string): ShutdownVerificationProof {
  let db: Database.Database;
  try {
    db = new Database(path, { fileMustExist: true });
  } catch {
    throw new RestoreVerificationError("application_readiness", "shutdown_database_reopen_failed");
  }
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") {
      throw new RestoreVerificationError("application_readiness", "shutdown_integrity_failed");
    }
    db.pragma("busy_timeout = 0");
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch {
      throw new RestoreVerificationError("application_readiness", "writer_lock_unavailable");
    } finally {
      if (db.inTransaction) db.exec("ROLLBACK");
    }
  } finally {
    db.close();
  }
  return {
    childExitCode: 0,
    databaseIntegrity: "ok",
    writerLock: "available",
  };
}

function syntheticProbeEnvironment(
  options: RestoredApplicationReadinessOptions,
  identity: { releaseSha: string; buildHash: string },
): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    NODE_ENV: "production",
    // Ordinary configuration still rejects PORT=0. The explicit child argument
    // plus an IPC channel tells server.start() to bind loopback port 0 instead.
    PORT: "1",
    BASE_URL: `http://${LOOPBACK_HOST}:1`,
    CLOCKIFY_ADDON_KEY: "restore-readiness-probe",
    SESSION_SECRET: "restore-readiness-probe-session-secret-v1",
    DATA_ENCRYPTION_KEY: options.encryptionKey,
    ...(options.previousEncryptionKey === undefined
      ? {}
      : { DATA_ENCRYPTION_KEY_PREVIOUS: options.previousEncryptionKey }),
    DATABASE_PATH: options.restoredPath,
    ASSISTANT_ENGINE: options.assistantEngine ?? "v1",
    LLM_PROVIDER: "http",
    LLM_MODE: "tool",
    LLM_AGENTIC: "1",
    LLM_TOOL_SELECT: "1",
    // The readiness path never invokes the model, but it must still boot with
    // the same fail-closed DeepSeek endpoint/model contract as production.
    LLM_BASE_URL: "https://api.deepseek.com",
    LLM_API_KEY: "restore-readiness-probe-unused",
    LLM_MODEL: "deepseek-v4-pro",
    RELEASE_SHA: identity.releaseSha,
    RELEASE_BUILD_HASH: identity.buildHash,
  };
}

async function pollHealth(input: {
  baseUrl: string;
  child: ChildProcess;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  identity: { releaseSha: string; buildHash: string };
}): Promise<void> {
  const deadline = performance.now() + input.timeoutMs;
  while (performance.now() < deadline) {
    if (input.child.exitCode !== null || input.child.signalCode !== null) {
      throw new RestoreVerificationError("application_readiness", "startup_exited");
    }
    const remaining = Math.max(1, deadline - performance.now());
    try {
      const version = await input.fetchImpl(`${input.baseUrl}/version`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(500, remaining)),
      });
      if (version.status !== 200) {
        await version.body?.cancel().catch(() => undefined);
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        continue;
      }
      let versionPayload: unknown;
      try {
        versionPayload = await version.json() as unknown;
      } catch {
        throw new RestoreVerificationError("application_readiness", "instance_identity_mismatch");
      }
      if (
        typeof versionPayload !== "object" || versionPayload === null || Array.isArray(versionPayload)
        || (versionPayload as Record<string, unknown>).releaseSha !== input.identity.releaseSha
        || (versionPayload as Record<string, unknown>).buildHash !== input.identity.buildHash
      ) {
        throw new RestoreVerificationError("application_readiness", "instance_identity_mismatch");
      }
      const response = await input.fetchImpl(`${input.baseUrl}/health`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(500, remaining)),
      });
      if (response.status === 200) {
        let payload: unknown;
        try {
          payload = await response.json() as unknown;
        } catch {
          throw new RestoreVerificationError("application_readiness", "malformed_health_response");
        }
        if (
          typeof payload === "object" && payload !== null && !Array.isArray(payload)
          && (payload as Record<string, unknown>).ok === true
        ) {
          return;
        }
        throw new RestoreVerificationError("application_readiness", "malformed_health_response");
      }
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      if (error instanceof RestoreVerificationError) throw error;
      // Connection refusal and short per-request timeouts are expected while
      // production startup initialization and reconciliation are still running.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new RestoreVerificationError("application_readiness", "readiness_timeout");
}

/**
 * Start the exact built production server entrypoint against only the private
 * restored clone, receive its child-bound loopback port over IPC, wait for its
 * public readiness route, then stop and prove the database is unlocked and
 * integral. Synthetic
 * unused planner/session values avoid loading unrelated production credentials;
 * the restored encryption key remains process-local and is never returned.
 */
export async function probeRestoredApplicationReadiness(
  options: RestoredApplicationReadinessOptions,
): Promise<ApplicationReadinessProof> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new RestoreVerificationError("application_readiness", "invalid_timeout");
  }
  if (
    !RELEASE_SHA_PATTERN.test(options.releaseSha)
    || !SHA256_PATTERN.test(options.releaseBuildHash)
  ) {
    throw new RestoreVerificationError("application_readiness", "release_identity_required");
  }
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const startedAt = monotonicNow();
  const identity = {
    releaseSha: options.releaseSha,
    buildHash: options.releaseBuildHash,
  };
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const serverEntry = fileURLToPath(new URL("../../dist/server/server.js", import.meta.url));
  let releaseArtifact: ReturnType<typeof verifyBuiltReleaseArtifact>;
  try {
    releaseArtifact = verifyBuiltReleaseArtifact({
      repositoryRoot,
      releaseSha: identity.releaseSha,
      releaseBuildHash: identity.buildHash,
    });
  } catch (error) {
    if (error instanceof ReleaseArtifactIdentityError) {
      throw new RestoreVerificationError("application_readiness", error.code);
    }
    throw new RestoreVerificationError(
      "application_readiness",
      "release_artifact_verification_failed",
    );
  }
  const child = spawn(process.execPath, [serverEntry, RESTORE_PROBE_CHILD_ARG], {
    cwd: repositoryRoot,
    env: syntheticProbeEnvironment(options, identity),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  // Drain, but never retain or surface, child output: startup failures must use
  // the bounded secret-free error codes below rather than arbitrary logs.
  child.stdout?.resume();
  child.stderr?.resume();
  const exited = exitPromise(child);
  let stopped = false;
  try {
    const startupDeadline = performance.now() + timeoutMs;
    const port = await waitForProbePort(child, exited, timeoutMs);
    const remainingMs = Math.max(1, startupDeadline - performance.now());
    await pollHealth({
      baseUrl: `http://${LOOPBACK_HOST}:${port}`,
      child,
      timeoutMs: remainingMs,
      fetchImpl: options.fetchImpl ?? fetch,
      identity,
    });
    const readinessConfirmedAt = (options.now ?? (() => new Date()))().toISOString();
    const elapsedMs = Math.max(
      0,
      Math.round((monotonicNow() - startedAt) * 10) / 10,
    );
    await stopOneOffInstance(child, exited);
    stopped = true;
    const shutdownVerification = verifyStoppedDatabase(options.restoredPath);
    return {
      endpoint: "GET /health",
      httpStatus: 200,
      startupInitialization: "production",
      serverArtifact: "dist/server/server.js",
      portBinding: "child_ephemeral_ipc",
      releaseSha: identity.releaseSha,
      releaseBuildHash: identity.buildHash,
      serverArtifactSha256: releaseArtifact.serverArtifactSha256,
      readinessConfirmedAt,
      elapsedMs,
      shutdownVerification,
    };
  } finally {
    if (!stopped && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await within(exited, 1_000);
    }
  }
}
