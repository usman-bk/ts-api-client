/**
 * Errors the app can branch on.
 *
 * A client that throws `Error("Request failed with status code 503")` makes
 * every caller parse a string to decide whether to show a retry button, and
 * the string changes when somebody rewords it. These carry the decision.
 */

export type Retryable = boolean;

export abstract class ApiError extends Error {
  abstract readonly kind: string;
  /** Whether trying the same request again could plausibly work. */
  abstract readonly retryable: Retryable;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** No answer at all: aeroplane mode, a tunnel, a dead access point. */
export class OfflineError extends ApiError {
  readonly kind = "offline" as const;
  readonly retryable = true;
  // override, because Error itself has carried a cause since ES2022 and
  // shadowing it silently would throw away whatever the platform put there.
  constructor(override readonly cause: unknown) {
    super("the network did not answer");
  }
}

/** The request took longer than the client was willing to wait. */
export class TimeoutError extends ApiError {
  readonly kind = "timeout" as const;
  readonly retryable = true;
  constructor(readonly afterMs: number) {
    super(`no response within ${afterMs}ms`);
  }
}

/** The caller gave up, usually because a screen was closed. */
export class CancelledError extends ApiError {
  readonly kind = "cancelled" as const;
  readonly retryable = false;
  constructor() {
    super("the request was cancelled");
  }
}

/**
 * The server said no, and meant it: 400, 404, 422.
 *
 * Not retryable, because the same request produces the same answer. An app
 * that retries these turns one bad request into five.
 */
export class ClientError extends ApiError {
  readonly kind = "client" as const;
  readonly retryable = false;
  constructor(readonly status: number, readonly body: unknown, readonly code?: string) {
    super(`request rejected with ${status}${code ? ` (${code})` : ""}`);
  }
}

/** 401 after a refresh has already been attempted. The app signs out. */
export class UnauthorizedError extends ApiError {
  readonly kind = "unauthorized" as const;
  readonly retryable = false;
  constructor(readonly body: unknown) {
    super("not authenticated");
  }
}

/** 429. Carries the server's own instruction about when to come back. */
export class RateLimitedError extends ApiError {
  readonly kind = "rate_limited" as const;
  readonly retryable = true;
  constructor(readonly retryAfterMs: number | null) {
    super(
      retryAfterMs === null
        ? "rate limited"
        : `rate limited, retry after ${retryAfterMs}ms`,
    );
  }
}

/** 5xx. The request was fine and the server was not. */
export class ServerError extends ApiError {
  readonly kind = "server" as const;
  readonly retryable = true;
  constructor(readonly status: number, readonly body: unknown) {
    super(`server returned ${status}`);
  }
}

/** A 2xx whose body is not what the contract says. */
export class DecodeError extends ApiError {
  readonly kind = "decode" as const;
  readonly retryable = false;
  constructor(readonly detail: string) {
    super(`the response did not match the contract: ${detail}`);
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Whether it is worth trying again, for anything thrown by this client. */
export function isRetryable(e: unknown): boolean {
  return isApiError(e) && e.retryable;
}
