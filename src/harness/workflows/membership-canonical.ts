function rateEquivalent(expected: unknown, actual: unknown): boolean {
  if (expected === undefined || expected === null) return true;
  if (!expected || typeof expected !== "object" || Array.isArray(expected) ||
      !actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const left = expected as Record<string, unknown>;
  const right = actual as Record<string, unknown>;
  return left.amount === right.amount && (left.since === undefined || left.since === right.since);
}

export function projectMembershipsEquivalent(
  expected: Array<Record<string, unknown>>,
  actual: Array<Record<string, unknown>>,
): boolean {
  if (expected.length !== actual.length) return false;
  const expectedUserIds = new Set(expected.map((row) => row.userId));
  if (expectedUserIds.size !== expected.length) return false;
  const actualByUser = new Map(actual.map((row) => [row.userId, row]));
  if (actualByUser.size !== actual.length) return false;
  return expected.every((row) => {
    const readback = actualByUser.get(row.userId);
    if (!readback) return false;
    const statusMatches = row.membershipStatus === undefined
      ? readback.membershipStatus === undefined || readback.membershipStatus === "ACTIVE"
      : row.membershipStatus === readback.membershipStatus;
    const typeMatches = row.membershipType === undefined
      ? readback.membershipType === undefined || readback.membershipType === "PROJECT"
      : row.membershipType === readback.membershipType;
    return statusMatches && typeMatches
      && rateEquivalent(row.hourlyRate, readback.hourlyRate)
      && rateEquivalent(row.costRate, readback.costRate);
  });
}
