import type { ListResult } from "../types.js";
import { MAX_PAGES } from "./core.js";

export interface PageResult<T> {
  rows: T[];
  total?: number;
}

/** Paginate POST/search endpoints while preserving whether the scan completed. */
export async function collectPages<T>(input: {
  label: string;
  pageSize: number;
  firstPage?: number;
  load: (page: number, pageSize: number) => Promise<PageResult<T>>;
}): Promise<ListResult<T>> {
  const rows: T[] = [];
  const firstPage = input.firstPage ?? 1;
  for (let offset = 0; offset < MAX_PAGES; offset++) {
    const page = await input.load(firstPage + offset, input.pageSize);
    rows.push(...page.rows);
    if (page.total !== undefined && rows.length >= page.total) {
      return { rows, truncated: false };
    }
    if (page.rows.length < input.pageSize) {
      return { rows, truncated: false };
    }
  }
  console.warn(
    `Clockify list ${input.label} hit the ${MAX_PAGES}-page backstop (${rows.length} rows); the result is truncated/incomplete.`,
  );
  return { rows, truncated: true };
}

/** Exact-id list scans must never turn an incomplete scan into a false absence. */
export function assertCompleteAbsence(truncated: boolean, noun: string, id: string): void {
  if (truncated) {
    throw new Error(
      `Clockify returned an incomplete ${noun} list, so id ${id} could not be verified. Retry with a narrower filter.`,
    );
  }
}
