export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  description: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`Malformed ${description}: expected fields ${wanted.join(", ")}`);
  }
}

export function requireNonEmptyString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Malformed ${description}: expected a non-empty string`);
  }
  return value.trim();
}

export function requireUnexpiredDate(
  value: unknown,
  now: Date,
  malformedDescription: string,
  expiredDescription: string,
): string {
  const expiry = requireNonEmptyString(value, malformedDescription);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    throw new Error(`Malformed ${malformedDescription}: expiry must use YYYY-MM-DD`);
  }

  const parsed = new Date(`${expiry}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== expiry) {
    throw new Error(`Malformed ${malformedDescription}: expiry is not a real date`);
  }
  if (Number.isNaN(now.getTime())) {
    throw new Error("Malformed dependency-gate clock");
  }
  if (expiry < now.toISOString().slice(0, 10)) {
    throw new Error(`${expiredDescription}: expired on ${expiry}`);
  }
  return expiry;
}
