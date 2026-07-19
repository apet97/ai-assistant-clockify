function validateReleaseBaseUrl(raw: string | undefined): string {
  if (!raw) throw new Error("BASE_URL is required.");
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") throw new Error("BASE_URL must use HTTPS.");
  if (parsed.username || parsed.password) throw new Error("BASE_URL must not contain credentials.");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("BASE_URL must be an origin without a path, query, or fragment.");
  }
  return parsed.origin;
}

try {
  process.stdout.write(`${validateReleaseBaseUrl(process.argv[2])}\n`);
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 64;
}
