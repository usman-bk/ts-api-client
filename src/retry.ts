import { isRetryable, RateLimitedError } from "./errors.js";

export interface RetryPolicy {
  /** Attempts in total, so 3 means one try and two retries. */
  attempts: number;
  baseMs: number;
  maxMs: number;
  /** Replaceable so a test does not sleep. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  random(): number;
}

export const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export const defaultPolicy: RetryPolicy = {
  attempts: 3,
  baseMs: 300,
  maxMs: 8_000,
  sleep: defaultSleep,
  random: Math.random,
};

/**
 * Full jitter: a random wait in [0, exponential].
 *
 * Plain exponential backoff is the version everybody writes, and it has a
 * failure mode that only appears at scale. A server comes back after an
 * outage, every client that was waiting retries at the same computed
 * moment, and the server falls over again. The clients were synchronised
 * by the outage and the backoff keeps them synchronised.
 *
 * Randomising the whole interval rather than adding a little noise to it
 * spreads them properly. It is the "full jitter" from the AWS architecture
 * blog, and it is both simpler than the alternatives and better than them.
 */
export function backoffMs(attempt: number, p: RetryPolicy): number {
  const exponential = Math.min(p.maxMs, p.baseMs * 2 ** attempt);
  return Math.floor(p.random() * exponential);
}

/**
 * Runs an operation, retrying what is worth retrying.
 *
 * `idempotent` is the caller's promise, not a guess. A GET is safe to
 * repeat; a POST that creates an order is not, and retrying it after a
 * timeout is how somebody is charged twice. The default is false, so
 * repeating a request is something a caller has to ask for.
 *
 * A 429 is obeyed rather than backed off: the server has said when to come
 * back, and guessing instead is both ruder and less effective.
 */
export async function withRetry<T>(
  op: (attempt: number) => Promise<T>,
  opts: { idempotent: boolean; policy?: RetryPolicy; signal?: AbortSignal },
): Promise<T> {
  const p = opts.policy ?? defaultPolicy;
  let lastError: unknown;

  for (let attempt = 0; attempt < p.attempts; attempt += 1) {
    try {
      return await op(attempt);
    } catch (e) {
      lastError = e;

      if (!opts.idempotent || !isRetryable(e)) throw e;
      if (attempt === p.attempts - 1) throw e;

      const wait =
        e instanceof RateLimitedError && e.retryAfterMs !== null
          ? e.retryAfterMs
          : backoffMs(attempt, p);

      await p.sleep(wait, opts.signal);
    }
  }
  throw lastError;
}
