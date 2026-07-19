import { describe, expect, it } from "vitest";

import { runOrderedCohorts } from "../../scripts/eval/ordered-cohorts.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("ordered evaluation cohorts", () => {
  it("does not start any cohort N+1 case until every cohort N case settles", async () => {
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const cohortTwoStarted = deferred();
    const started: string[] = [];
    const running = runOrderedCohorts(["a", "b"], 2, 2, async ({ cohortIndex, caseIndex, value }) => {
      started.push(`${cohortIndex}:${caseIndex}:${value}`);
      if (cohortIndex === 2) cohortTwoStarted.resolve();
      await gates[(cohortIndex - 1) * 2 + caseIndex]!.promise;
      return `${cohortIndex}:${value}`;
    });

    await Promise.resolve();
    expect(started).toEqual(["1:0:a", "1:1:b"]);
    gates[0]!.resolve();
    await Promise.resolve();
    expect(started).toEqual(["1:0:a", "1:1:b"]);
    gates[1]!.resolve();
    await cohortTwoStarted.promise;
    expect(started).toEqual(["1:0:a", "1:1:b", "2:0:a", "2:1:b"]);
    gates[2]!.resolve();
    gates[3]!.resolve();
    await expect(running).resolves.toEqual(["1:a", "1:b", "2:a", "2:b"]);
  });
});
