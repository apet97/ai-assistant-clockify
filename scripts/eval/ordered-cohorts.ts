export interface OrderedCohortUnit<T> {
  value: T;
  cohortIndex: number;
  caseIndex: number;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** A real cohort barrier: cases may run concurrently inside one pass, but the
 * next pass is not created or dispatched until every prior case has settled. */
export async function runOrderedCohorts<T, R>(
  values: readonly T[],
  cohortCount: number,
  concurrency: number,
  run: (unit: OrderedCohortUnit<T>) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(cohortCount) || cohortCount < 1) throw new Error("cohort count must be positive");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("cohort concurrency must be positive");
  const results: R[] = [];
  for (let cohortIndex = 1; cohortIndex <= cohortCount; cohortIndex += 1) {
    const cohort = values.map((value, caseIndex) => ({ value, cohortIndex, caseIndex }));
    results.push(...await mapWithConcurrency(cohort, concurrency, run));
  }
  return results;
}
