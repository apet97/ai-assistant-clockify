/**
 * Typed host-write failures. A definitive failure proves the host rejected the
 * write. An ambiguous outcome means the request was dispatched but the client
 * cannot prove whether Clockify applied it, so callers must not retry blindly.
 */
export class DefinitiveWriteFailure extends Error {
  readonly outcome = "definitive_failure" as const;

  constructor(
    readonly method: string,
    readonly path: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DefinitiveWriteFailure";
  }
}

export class AmbiguousWriteOutcome extends Error {
  readonly outcome = "ambiguous_outcome" as const;

  constructor(
    readonly method: string,
    readonly path: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AmbiguousWriteOutcome";
  }
}

export function isMutationMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}
