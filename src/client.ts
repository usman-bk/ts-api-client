import { Auth } from "./auth.js";
import {
  CancelledError,
  ClientError,
  DecodeError,
  OfflineError,
  RateLimitedError,
  ServerError,
  TimeoutError,
  UnauthorizedError,
} from "./errors.js";
import { defaultPolicy, withRetry, type RetryPolicy } from "./retry.js";

export interface ClientOptions {
  baseUrl: string;
  auth?: Auth;
  /** Injected so the tests do not need a server and the app can swap it. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  retry?: RetryPolicy;
  userAgent?: string;
}

export interface RequestOptions<T> {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Validates and narrows the response. See decode below. */
  decode: (raw: unknown) => T;
  /**
   * Whether repeating this request is safe. Not inferred from the method:
   * see the note on idempotency below.
   */
  idempotent?: boolean;
  /** Sent as Idempotency-Key, which makes an unsafe request safe to repeat. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

export class Client {
  private readonly baseUrl: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly policy: RetryPolicy;

  constructor(private readonly opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.policy = opts.retry ?? defaultPolicy;
  }

  async request<T>(o: RequestOptions<T>): Promise<T> {
    // A GET is safe to repeat. Anything else is only safe if the caller
    // says so, or if it carries an idempotency key the server honours.
    // Inferring this from the method alone is how a retried POST charges
    // somebody twice.
    const idempotent =
      o.idempotent ?? (o.method === "GET" || o.idempotencyKey !== undefined);

    return withRetry(
      async (attempt) => this.once(o, attempt),
      { idempotent, policy: this.policy, ...(o.signal ? { signal: o.signal } : {}) },
    );
  }

  private async once<T>(o: RequestOptions<T>, attempt: number): Promise<T> {
    const url = this.url(o.path, o.query);
    const timeoutMs = o.timeoutMs ?? this.timeoutMs;

    const headers: Record<string, string> = {
      accept: "application/json",
      ...(this.opts.userAgent ? { "user-agent": this.opts.userAgent } : {}),
    };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    if (o.idempotencyKey) {
      // The same key on every attempt, which is the entire point: a
      // regenerated key makes the retry a different request and the
      // server cannot recognise it.
      headers["idempotency-key"] = o.idempotencyKey;
    }
    if (attempt > 0) headers["x-retry-attempt"] = String(attempt);

    const token = await this.opts.auth?.currentAccessToken();
    if (token) headers["authorization"] = `Bearer ${token}`;

    let res: Response;
    try {
      res = await this.send(url, o, headers, timeoutMs);
    } catch (e) {
      throw this.networkError(e, timeoutMs, o.signal);
    }

    // One retry after a refresh, and only one. A second 401 means the
    // refresh itself is not helping, and looping would hammer the auth
    // service while the customer waits.
    if (res.status === 401 && this.opts.auth && attempt === 0) {
      const refreshed = await this.opts.auth.refresh().catch(() => null);
      if (refreshed) {
        headers["authorization"] = `Bearer ${refreshed.accessToken}`;
        try {
          res = await this.send(url, o, headers, timeoutMs);
        } catch (e) {
          throw this.networkError(e, timeoutMs, o.signal);
        }
      }
    }

    return this.handle(res, o);
  }

  private async send<T>(
    url: string,
    o: RequestOptions<T>,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<Response> {
    // The caller's signal and the timeout are combined, so whichever
    // fires first aborts the request and neither leaks a pending timer.
    const controller = new AbortController();

    // Checked before the listener is attached, because a signal that has
    // already aborted will never fire one. A request made with a dead
    // signal otherwise waits for the full timeout, which is what a screen
    // closed a moment before its data was requested looks like.
    if (o.signal?.aborted) {
      controller.abort(o.signal.reason);
    }

    const onAbort = (): void => controller.abort(o.signal?.reason);
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new TimeoutError(timeoutMs)), timeoutMs);

    try {
      return await this.doFetch(url, {
        method: o.method,
        headers,
        signal: controller.signal,
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
      });
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    }
  }

  private networkError(e: unknown, timeoutMs: number, signal?: AbortSignal): Error {
    if (e instanceof TimeoutError) return e;
    if (signal?.aborted) return new CancelledError();
    if (e instanceof DOMException && e.name === "AbortError") {
      return new TimeoutError(timeoutMs);
    }
    // fetch rejects with a TypeError for anything it could not send,
    // which from a phone is almost always no network.
    return new OfflineError(e);
  }

  private async handle<T>(res: Response, o: RequestOptions<T>): Promise<T> {
    if (res.status === 204) return o.decode(undefined);

    const raw = await this.readBody(res);

    if (res.ok) {
      try {
        return o.decode(raw);
      } catch (e) {
        throw new DecodeError(e instanceof Error ? e.message : String(e));
      }
    }

    if (res.status === 401) throw new UnauthorizedError(raw);
    if (res.status === 429) throw new RateLimitedError(retryAfterMs(res));
    if (res.status >= 500) throw new ServerError(res.status, raw);

    const code =
      raw && typeof raw === "object" && "code" in raw && typeof raw.code === "string"
        ? raw.code
        : undefined;
    throw new ClientError(res.status, raw, code);
  }

  private async readBody(res: Response): Promise<unknown> {
    const text = await res.text().catch(() => "");
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Not json. An error page from a proxy, usually, and the text is
      // more useful to a log than a parse failure would be.
      return text;
    }
  }

  private url(path: string, query?: RequestOptions<unknown>["query"]): string {
    const u = `${this.baseUrl}/${path.replace(/^\/+/, "")}`;
    if (!query) return u;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const s = params.toString();
    return s ? `${u}?${s}` : u;
  }
}

/** Reads Retry-After, which is either seconds or an HTTP date. */
export function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const at = Date.parse(header);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
}
