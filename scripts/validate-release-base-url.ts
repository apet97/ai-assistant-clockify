import { privateProductionRailwayOrigin } from "./lib/private-production-origin.js";

function validateReleaseBaseUrl(raw: string | undefined): string {
  if (!raw) throw new Error("BASE_URL is required.");
  const parsed = privateProductionRailwayOrigin(raw);
  if (!parsed) throw new Error("BASE_URL must be the exact private production Railway origin.");
  return parsed.origin;
}

try {
  process.stdout.write(`${validateReleaseBaseUrl(process.argv[2])}\n`);
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 64;
}
