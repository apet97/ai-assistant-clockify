import { describe, expect, it } from "vitest";
import {
  assertRollbackCoverage,
  deployPrivateProduction,
  desiredReleaseVariables,
  parseRollbackVariableSnapshot,
  type DeployCommandRunner,
} from "../../scripts/deploy-private-production.js";

const RAILWAY_PROJECT_ID = "fb1fa3c6-cc28-40d8-b985-2a7ee7051304";
const RAILWAY_SERVICE_ID = "2656670e-39a5-40f3-af5c-56dfc637552f";
const RAILWAY_ENVIRONMENT_ID = "45300bdc-788b-4f63-8749-5a8f7e46b774";

function expectExactRailwayTarget(args: string[]): void {
  for (const [flag, id] of [
    ["-p", RAILWAY_PROJECT_ID],
    ["-s", RAILWAY_SERVICE_ID],
    ["-e", RAILWAY_ENVIRONMENT_ID],
  ] as const) {
    const indexes = args.flatMap((value, index) => value === flag ? [index] : []);
    expect(indexes, `${flag} must occur exactly once`).toHaveLength(1);
    expect(args[indexes[0]! + 1], `${flag} must target the exact id`).toBe(id);
  }
  for (const duplicate of ["--project", "--service", "--environment"]) {
    expect(args).not.toContain(duplicate);
  }
  expect(args).not.toContain("ai-assistant");
  expect(args).not.toContain("production");
  expect(args).not.toContain("--no-local");
}

const releaseEnvironment = (): NodeJS.ProcessEnv => ({
  RELEASE_STAGING: process.cwd(),
  RELEASE_SHA: "a".repeat(40),
  RELEASE_BUILD_HASH: "b".repeat(64),
  RELEASE_SOURCE_BINDING_SHA256: "c".repeat(64),
  RELEASE_SERVER_ARTIFACT_SHA256: "d".repeat(64),
  PREDEPLOY_BACKUP_METADATA_PATH: "/tmp/backup-metadata.json",
  SELECTED_LLM_MODEL: "deepseek-v4-pro",
  SELECTED_REASONING_EFFORT: "unset",
  SELECTED_THINKING_MODE: "disabled",
});

const priorVariables = {
  RELEASE_SHA: "1".repeat(40),
  RELEASE_BUILD_HASH: "2".repeat(64),
  RELEASE_SOURCE_BINDING_SHA256: "3".repeat(64),
  LLM_MODEL: "deepseek-v4-pro",
  LLM_THINKING_MODE: "disabled",
};

describe("private production deployment transaction", () => {
  it("captures only the allowlisted nonsecret release and model settings", () => {
    expect(parseRollbackVariableSnapshot(JSON.stringify({
      RELEASE_SHA: "old-sha",
      RELEASE_BUILD_HASH: "old-build",
      LLM_MODEL: "deepseek-v4-pro",
      LLM_THINKING_MODE: "disabled",
      LLM_API_KEY: "must-never-enter-the-snapshot",
      SESSION_SECRET: "must-never-enter-the-snapshot",
    }))).toEqual({
      RELEASE_SHA: "old-sha",
      RELEASE_BUILD_HASH: "old-build",
      LLM_MODEL: "deepseek-v4-pro",
      LLM_THINKING_MODE: "disabled",
    });
  });

  it("builds the exact variable mutation without blank model settings", () => {
    expect(desiredReleaseVariables({
      RELEASE_SHA: "a".repeat(40),
      RELEASE_BUILD_HASH: "b".repeat(64),
      RELEASE_SOURCE_BINDING_SHA256: "c".repeat(64),
      SELECTED_LLM_MODEL: "deepseek-v4-pro",
      SELECTED_REASONING_EFFORT: "unset",
      SELECTED_THINKING_MODE: "disabled",
    })).toEqual({
      RELEASE_SHA: "a".repeat(40),
      RELEASE_BUILD_HASH: "b".repeat(64),
      RELEASE_SOURCE_BINDING_SHA256: "c".repeat(64),
      LLM_MODEL: "deepseek-v4-pro",
      LLM_THINKING_MODE: "disabled",
    });
    expect(() => desiredReleaseVariables({
      RELEASE_SHA: "a".repeat(40),
      RELEASE_BUILD_HASH: "b".repeat(64),
      RELEASE_SOURCE_BINDING_SHA256: "c".repeat(64),
      SELECTED_LLM_MODEL: "deepseek-v4-pro",
      SELECTED_REASONING_EFFORT: "unset",
      SELECTED_THINKING_MODE: "unset",
    }, { LLM_THINKING_MODE: "disabled" })).toThrow(/must already be absent/u);
  });

  it("refuses a mutation that would require a deploy-triggering delete to roll back", () => {
    expect(() => assertRollbackCoverage(
      { RELEASE_SHA: "old" },
      { RELEASE_SHA: "new", RELEASE_BUILD_HASH: "new-build" },
    )).toThrow(/RELEASE_BUILD_HASH/u);
    expect(() => assertRollbackCoverage(
      { RELEASE_SHA: "old", RELEASE_BUILD_HASH: "old-build" },
      { RELEASE_SHA: "new", RELEASE_BUILD_HASH: "new-build" },
    )).not.toThrow();
  });

  it("gates and snapshots before the one variable mutation and upload", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: DeployCommandRunner = (command, args) => {
      calls.push({ command, args });
      if (command === "railway" && args[0] === "--version") return "railway 5.27.0";
      if (command === "railway" && args[0] === "variable" && args[1] === "list") {
        return JSON.stringify(priorVariables);
      }
      return "";
    };

    expect(() => deployPrivateProduction(releaseEnvironment(), runner)).not.toThrow();
    const gate = calls.findIndex(({ command, args }) => command === "npm" && args.includes("gate:predeploy-backup"));
    const snapshot = calls.findIndex(({ command, args }) =>
      command === "railway" && args[0] === "variable" && args[1] === "list");
    const mutation = calls.findIndex(({ command, args }) =>
      command === "railway" && args[0] === "variable" && args[1] === "set");
    const upload = calls.findIndex(({ command, args }) => command === "railway" && args[0] === "up");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(snapshot).toBeGreaterThan(gate);
    expect(mutation).toBeGreaterThan(snapshot);
    expect(upload).toBeGreaterThan(mutation);
    expect(calls.filter(({ command, args }) =>
      command === "railway" && args[0] === "variable" && args[1] === "set")).toHaveLength(1);
  });

  it("pins every Railway variable and upload command to the exact production ids", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: DeployCommandRunner = (command, args) => {
      calls.push({ command, args });
      if (command === "railway" && args[0] === "--version") return "railway 5.27.0";
      if (command === "railway" && args[0] === "variable" && args[1] === "list") {
        return JSON.stringify(priorVariables);
      }
      return "";
    };

    deployPrivateProduction(releaseEnvironment(), runner);

    const targetedCalls = calls.filter(({ command, args }) =>
      command === "railway" && (args[0] === "variable" || args[0] === "up"));
    expect(targetedCalls).toHaveLength(3);
    for (const { args } of targetedCalls) expectExactRailwayTarget(args);
  });

  it.each(["set", "up"] as const)(
    "restores every prior value when Railway %s fails after mutation begins",
    (failurePoint) => {
      const calls: Array<{ command: string; args: string[] }> = [];
      let initialSetSeen = false;
      const runner: DeployCommandRunner = (command, args) => {
        calls.push({ command, args });
        if (command === "railway" && args[0] === "--version") return "railway 5.27.0";
        if (command === "railway" && args[0] === "variable" && args[1] === "list") {
          return JSON.stringify(priorVariables);
        }
        if (command === "railway" && args[0] === "variable" && args[1] === "set" && !initialSetSeen) {
          initialSetSeen = true;
          if (failurePoint === "set") throw new Error("ambiguous variable set failure");
          return "";
        }
        if (command === "railway" && args[0] === "up" && failurePoint === "up") {
          throw new Error("upload failure");
        }
        return "";
      };

      expect(() => deployPrivateProduction(releaseEnvironment(), runner)).toThrow(/restored/u);
      const gateIndex = calls.findIndex(({ command, args }) =>
        command === "npm" && args.includes("gate:predeploy-backup"));
      const firstSetIndex = calls.findIndex(({ command, args }) =>
        command === "railway" && args[0] === "variable" && args[1] === "set");
      expect(gateIndex).toBeGreaterThanOrEqual(0);
      expect(firstSetIndex).toBeGreaterThan(gateIndex);

      const rollbackSets = calls.filter(({ command, args }, index) =>
        index > firstSetIndex && command === "railway" && args[0] === "variable" && args[1] === "set");
      expect(rollbackSets).toHaveLength(Object.keys(priorVariables).length);
      for (const [key, value] of Object.entries(priorVariables)) {
        expect(rollbackSets.some(({ args }) => args.includes(`${key}=${value}`))).toBe(true);
      }
      if (failurePoint === "set") {
        expect(calls.some(({ command, args }) => command === "railway" && args[0] === "up")).toBe(false);
      }
      const targetedCalls = calls.filter(({ command, args }) =>
        command === "railway" && (args[0] === "variable" || args[0] === "up"));
      for (const { args } of targetedCalls) expectExactRailwayTarget(args);
    },
  );
});
