import { describe, expect, it, vi } from "vitest";
import { createRoleRechecker } from "../../src/auth/role-recheck.js";
import type { WorkspaceClient } from "../../src/clockify/client.js";

describe("positive-only role recheck cache", () => {
  it("coalesces concurrent cold non-forced checks for one installation generation", async () => {
    let release!: (role: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const lookup = vi.fn(async () => gate);
    const client = { getWorkspaceMemberRole: lookup } as unknown as WorkspaceClient;
    const checker = createRoleRechecker(60_000, () => 0);

    const checks = Array.from({ length: 4 }, () =>
      checker.check("ws", "admin", client, { generation: 7 }));
    expect(lookup).toHaveBeenCalledTimes(1);
    release("ADMIN");

    await expect(Promise.all(checks)).resolves.toEqual(["admin", "admin", "admin", "admin"]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("does not share a cold verdict across installation generations", async () => {
    const lookup = vi.fn(async () => "ADMIN");
    const client = { getWorkspaceMemberRole: lookup } as unknown as WorkspaceClient;
    const checker = createRoleRechecker(60_000, () => 0);

    await expect(checker.check("ws", "admin", client, { generation: 7 })).resolves.toBe("admin");
    await expect(checker.check("ws", "admin", client, { generation: 8 })).resolves.toBe("admin");

    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("caches only an admin pass for 60 seconds and force bypasses it for mutations", async () => {
    let now = 0;
    const roles = ["ADMIN", "MEMBER", "ADMIN"];
    const lookup = vi.fn(async () => roles.shift());
    const client = { getWorkspaceMemberRole: lookup } as unknown as WorkspaceClient;
    const checker = createRoleRechecker(60_000, () => now);

    expect(await checker.check("ws", "admin", client)).toBe("admin");
    expect(await checker.check("ws", "admin", client)).toBe("admin");
    expect(lookup).toHaveBeenCalledTimes(1);

    expect(await checker.check("ws", "admin", client, { force: true })).toBe("non_admin");
    expect(await checker.check("ws", "admin", client)).toBe("admin");
    expect(lookup).toHaveBeenCalledTimes(3);

    now = 60_001;
    expect(await checker.check("ws", "admin", client)).toBe("unknown");
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it("never caches a positive verdict for longer than 60 seconds", async () => {
    let now = 0;
    const lookup = vi.fn()
      .mockResolvedValueOnce("ADMIN")
      .mockResolvedValueOnce("MEMBER");
    const client = { getWorkspaceMemberRole: lookup } as unknown as WorkspaceClient;
    const checker = createRoleRechecker(3_600_000, () => now);

    expect(await checker.check("ws", "admin", client)).toBe("admin");
    now = 60_001;
    expect(await checker.check("ws", "admin", client)).toBe("non_admin");
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("never lets an older delayed ADMIN completion overwrite a newer demotion", async () => {
    let resolveOlder!: (role: string) => void;
    let resolveNewer!: (role: string) => void;
    const older = new Promise<string>((resolve) => { resolveOlder = resolve; });
    const newer = new Promise<string>((resolve) => { resolveNewer = resolve; });
    const lookup = vi.fn()
      .mockImplementationOnce(async () => older)
      .mockImplementationOnce(async () => newer)
      .mockResolvedValueOnce("MEMBER");
    const client = { getWorkspaceMemberRole: lookup } as unknown as WorkspaceClient;
    const checker = createRoleRechecker(60_000, () => 0);

    const staleCheck = checker.check("ws", "admin", client, { force: true });
    const demotionCheck = checker.check("ws", "admin", client, { force: true });
    resolveNewer("MEMBER");
    await expect(demotionCheck).resolves.toBe("non_admin");
    resolveOlder("ADMIN");
    await expect(staleCheck).resolves.toBe("unknown");
    await expect(checker.check("ws", "admin", client)).resolves.toBe("non_admin");
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it("fails every coalesced stale read closed after a newer forced demotion", async () => {
    let resolveOlder!: (role: string) => void;
    let resolveNewer!: (role: string) => void;
    const older = new Promise<string>((resolve) => { resolveOlder = resolve; });
    const newer = new Promise<string>((resolve) => { resolveNewer = resolve; });
    const lookup = vi.fn()
      .mockImplementationOnce(async () => older)
      .mockImplementationOnce(async () => newer)
      .mockResolvedValueOnce("MEMBER");
    const client = { getWorkspaceMemberRole: lookup } as unknown as WorkspaceClient;
    const checker = createRoleRechecker(60_000, () => 0);

    const cold = Array.from({ length: 4 }, () =>
      checker.check("ws", "admin", client, { generation: 3 }));
    const demotion = checker.check("ws", "admin", client, { force: true, generation: 3 });
    resolveNewer("MEMBER");
    await expect(demotion).resolves.toBe("non_admin");
    resolveOlder("ADMIN");

    await expect(Promise.all(cold)).resolves.toEqual(["unknown", "unknown", "unknown", "unknown"]);
    await expect(checker.check("ws", "admin", client, { generation: 3 })).resolves.toBe("non_admin");
    expect(lookup).toHaveBeenCalledTimes(3);
  });
});
