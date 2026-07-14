import { describe, expect, it } from "vitest";
import { createWorkspaceRequestGovernor, withHostCallBudget } from "../../src/clockify/request-governor.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("workspace request governor", () => {
  it("limits total host concurrency and serializes mutations", async () => {
    const governor = createWorkspaceRequestGovernor({ requestsPerSecond: 100, burst: 100, concurrency: 2 });
    let active = 0;
    let maxActive = 0;
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const gates = Array.from({ length: 4 }, deferred);
    const run = (index: number, kind: "read" | "mutation") => governor.run(kind, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (kind === "mutation") {
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      }
      await gates[index].promise;
      active -= 1;
      if (kind === "mutation") activeWrites -= 1;
      return index;
    });

    const tasks = [run(0, "mutation"), run(1, "mutation"), run(2, "read"), run(3, "read")];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(active).toBe(1);
    gates[0].resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(active).toBe(2);
    gates[1].resolve();
    gates[2].resolve();
    gates[3].resolve();
    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3]);
    expect(maxActive).toBe(2);
    expect(maxActiveWrites).toBe(1);
  });

  it("enforces a turn-scoped host-call ceiling", async () => {
    const governor = createWorkspaceRequestGovernor({ requestsPerSecond: 100, burst: 100, concurrency: 4 });
    await expect(withHostCallBudget(
      () => Promise.all(Array.from({ length: 4 }, () => governor.run("read", async () => "ok"))),
      3,
    )).rejects.toThrow("host-call budget exceeded");
  });
});
