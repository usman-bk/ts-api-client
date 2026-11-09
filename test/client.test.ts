import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Auth, MemoryTokenStorage, type Tokens } from "../src/auth.js";
import { Client, retryAfterMs } from "../src/client.js";
import {
  CancelledError,
  ClientError,
  DecodeError,
  OfflineError,
  RateLimitedError,
  ServerError,
  TimeoutError,
  UnauthorizedError,
  isRetryable,
} from "../src/errors.js";
import { MarketplaceApi, decodeListing } from "../src/api.js";
import type { RetryPolicy } from "../src/retry.js";

/** A fetch that answers from a script and records what it was asked. */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeFetch(
  replies: Array<Response | (() => Response | Promise<Response>) | Error>,
): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;

  const fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    if (reply instanceof Error) throw reply;
    if (!reply) throw new Error("the fake fetch ran out of replies");

    if (typeof reply === "function") {
      // Real fetch rejects when its signal aborts, and a fake that does
      // not will hang forever on the timeout tests rather than failing
      // them. Found by exactly that: the suite ran for ten minutes.
      const signal = init?.signal;
      return Promise.race([
        Promise.resolve(reply()),
        new Promise<Response>((_, reject) => {
          if (!signal) return;
          if (signal.aborted) {
            reject(signal.reason ?? new DOMException("aborted", "AbortError"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(signal.reason ?? new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
      ]);
    }
    // A Response body can only be read once, so each call gets a copy.
    return reply.clone();
  }) as typeof globalThis.fetch;

  return { fetch, calls };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** A policy that does not sleep and does not vary, so tests are quick. */
const instant: RetryPolicy = {
  attempts: 3,
  baseMs: 1,
  maxMs: 4,
  sleep: async () => undefined,
  random: () => 0.5,
};

const listing = {
  id: "l1",
  title: "iPhone 13 Pro 256 GB",
  grade: "excellent",
  priceCents: 48900,
  currency: "EUR",
  imageUrl: "https://img/1.avif",
  inStock: true,
};

describe("client", () => {
  it("sends the request and decodes the answer", async () => {
    const { fetch, calls } = fakeFetch([json({ items: [listing], nextCursor: null })]);
    const api = new MarketplaceApi(new Client({ baseUrl: "https://api.test", fetch, retry: instant }));

    const page = await api.search("iphone", { limit: 5 });

    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.title, "iPhone 13 Pro 256 GB");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/v1\/listings\?q=iphone&limit=5$/);
    assert.equal(calls[0]!.method, "GET");
  });

  it("leaves an undefined query parameter out rather than sending the word undefined", async () => {
    const { fetch, calls } = fakeFetch([json({ items: [], nextCursor: null })]);
    const api = new MarketplaceApi(new Client({ baseUrl: "https://api.test", fetch, retry: instant }));

    await api.search("x");
    assert.doesNotMatch(calls[0]!.url, /undefined/);
  });

  it("turns a 4xx into an error the app can branch on", async () => {
    const { fetch } = fakeFetch([json({ code: "bad_cursor" }, { status: 400 })]);
    const api = new MarketplaceApi(new Client({ baseUrl: "https://api.test", fetch, retry: instant }));

    await assert.rejects(
      () => api.search("x"),
      (e: unknown) => e instanceof ClientError && e.status === 400 && e.code === "bad_cursor",
    );
  });

  it("turns a 5xx into a retryable error", async () => {
    const { fetch } = fakeFetch([json({}, { status: 503 })]);
    const api = new MarketplaceApi(new Client({ baseUrl: "https://api.test", fetch, retry: instant }));

    await assert.rejects(api.search("x"), (e: unknown) => e instanceof ServerError && isRetryable(e));
  });

  it("retries a GET and succeeds", async () => {
    const { fetch, calls } = fakeFetch([
      json({}, { status: 503 }),
      json({}, { status: 503 }),
      json({ items: [listing], nextCursor: null }),
    ]);
    const api = new MarketplaceApi(new Client({ baseUrl: "https://api.test", fetch, retry: instant }));

    const page = await api.search("x");
    assert.equal(page.items.length, 1);
    assert.equal(calls.length, 3);
  });

  it("gives up after the attempt limit", async () => {
    const { fetch, calls } = fakeFetch([json({}, { status: 503 })]);
    const api = new MarketplaceApi(new Client({ baseUrl: "https://api.test", fetch, retry: instant }));

    await assert.rejects(api.search("x"), (e: unknown) => e instanceof ServerError);
    assert.equal(calls.length, instant.attempts);
  });

  it("does not retry a 4xx, because the answer will not change", async () => {
    const { fetch, calls } = fakeFetch([json({}, { status: 404 })]);
    const api = new MarketplaceApi(new Client({ baseUrl: "https://api.test", fetch, retry: instant }));

    await assert.rejects(api.listing("nope"), (e: unknown) => e instanceof ClientError);
    assert.equal(calls.length, 1, "a 404 was retried, which turns one bad request into three");
  });

  // Retrying a POST that creates something is how somebody is charged
  // twice. It is only safe when the server can recognise the repeat.
  it("does not retry a POST that carries no idempotency key", async () => {
    const { fetch, calls } = fakeFetch([json({}, { status: 503 })]);
    const client = new Client({ baseUrl: "https://api.test", fetch, retry: instant });

    await assert.rejects(
      client.request({
        method: "POST",
        path: "/v1/orders",
        body: { basketId: "b1" },
        decode: (raw) => raw,
      }),
      (e: unknown) => e instanceof ServerError,
    );
    assert.equal(calls.length, 1, "an unsafe POST was repeated");
  });

  it("retries a POST that carries one, and sends the same key every time", async () => {
    const { fetch, calls } = fakeFetch([
      json({}, { status: 503 }),
      json({ cart: [{ sku: "S1", qty: 1 }] }),
    ]);
    const api = new MarketplaceApi(new Client({ baseUrl: "https://api.test", fetch, retry: instant }));

    const cart = await api.addToBasket("S1", 1);
    assert.equal(cart.length, 1);
    assert.equal(calls.length, 2);

    const first = calls[0]!.headers["idempotency-key"];
    assert.ok(first, "no idempotency key was sent");
    assert.equal(
      calls[1]!.headers["idempotency-key"],
      first,
      "the retry used a different key, so the server cannot tell it is the same request",
    );
  });

  it("obeys Retry-After on a 429 instead of guessing", async () => {
    const waits: number[] = [];
    const policy: RetryPolicy = { ...instant, sleep: async (ms) => void waits.push(ms) };

    const { fetch } = fakeFetch([
      json({}, { status: 429, headers: { "retry-after": "2" } }),
      json({ items: [], nextCursor: null }),
    ]);
    const api = new MarketplaceApi(new Client({ baseUrl: "https://api.test", fetch, retry: policy }));

    await api.search("x");
    assert.deepEqual(waits, [2000]);
  });

  it("surfaces a 429 that never clears, carrying the wait the server asked for", async () => {
    const { fetch } = fakeFetch([json({}, { status: 429, headers: { "retry-after": "3" } })]);
    const api = new MarketplaceApi(new Client({ baseUrl: "https://api.test", fetch, retry: instant }));

    await assert.rejects(
      api.search("x"),
      (e: unknown) => e instanceof RateLimitedError && e.retryAfterMs === 3000,
    );
  });

  it("reads Retry-After as a date as well as seconds", () => {
    const soon = new Date(Date.now() + 5000).toUTCString();
    const res = new Response("", { headers: { "retry-after": soon } });
    const ms = retryAfterMs(res);
    assert.ok(ms !== null && ms > 3000 && ms <= 5000, `got ${ms}`);

    assert.equal(retryAfterMs(new Response("")), null);
    assert.equal(retryAfterMs(new Response("", { headers: { "retry-after": "nonsense" } })), null);
  });

  it("reports no network as offline, which is retryable", async () => {
    const { fetch } = fakeFetch([new TypeError("Failed to fetch")]);
    const api = new MarketplaceApi(new Client({ baseUrl: "https://api.test", fetch, retry: instant }));

    await assert.rejects(api.search("x"), (e: unknown) => e instanceof OfflineError && isRetryable(e));
  });

  it("times out", async () => {
    const { fetch } = fakeFetch([
      () => new Promise<Response>(() => undefined), // never answers
    ]);
    const client = new Client({
      baseUrl: "https://api.test",
      fetch,
      retry: { ...instant, attempts: 1 },
      timeoutMs: 20,
    });

    await assert.rejects(
      client.request({ method: "GET", path: "/slow", decode: (raw) => raw }),
      (e: unknown) => e instanceof TimeoutError,
    );
  });

  it("reports a cancelled request as cancelled, not as a timeout", async () => {
    const controller = new AbortController();
    const { fetch } = fakeFetch([
      () =>
        new Promise<Response>((_, reject) => {
          controller.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    ]);
    const client = new Client({ baseUrl: "https://api.test", fetch, retry: instant, timeoutMs: 5000 });

    const promise = client.request({
      method: "GET",
      path: "/slow",
      decode: (raw) => raw,
      signal: controller.signal,
    });
    controller.abort();

    await assert.rejects(promise, (e: unknown) => e instanceof CancelledError);
  });

  it("handles a 204 with no body", async () => {
    const { fetch } = fakeFetch([new Response(null, { status: 204 })]);
    const client = new Client({ baseUrl: "https://api.test", fetch, retry: instant });

    const got = await client.request({
      method: "DELETE",
      path: "/v1/basket/items/S1",
      idempotent: true,
      decode: () => "deleted" as const,
    });
    assert.equal(got, "deleted");
  });

  it("does not choke on an html error page from a proxy", async () => {
    const { fetch } = fakeFetch([
      new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    ]);
    const client = new Client({ baseUrl: "https://api.test", fetch, retry: { ...instant, attempts: 1 } });

    await assert.rejects(
      client.request({ method: "GET", path: "/x", decode: (raw) => raw }),
      (e: unknown) => e instanceof ServerError && typeof e.body === "string",
    );
  });
});

describe("auth", () => {
  function setup(opts: { refresher?: (t: string) => Promise<Tokens> } = {}): {
    auth: Auth;
    refreshes: () => number;
  } {
    let n = 0;
    const storage = new MemoryTokenStorage();
    const refresher = opts.refresher
      ? opts.refresher
      : async (): Promise<Tokens> => {
          n += 1;
          return { accessToken: `access-${n}`, refreshToken: `refresh-${n}`, expiresIn: 900 };
        };
    const auth = new Auth(storage, refresher);
    return { auth, refreshes: () => n };
  }

  it("refreshes once for a 401 and retries with the new token", async () => {
    const { auth } = setup();
    await auth.set({ accessToken: "old", refreshToken: "r1", expiresIn: 900 });

    const { fetch, calls } = fakeFetch([
      json({}, { status: 401 }),
      json({ items: [], nextCursor: null }),
    ]);
    const api = new MarketplaceApi(
      new Client({ baseUrl: "https://api.test", fetch, auth, retry: instant }),
    );

    await api.search("x");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.headers["authorization"], "Bearer old");
    assert.equal(calls[1]!.headers["authorization"], "Bearer access-1");
  });

  it("gives up after a second 401 rather than looping", async () => {
    const { auth } = setup();
    await auth.set({ accessToken: "old", refreshToken: "r1", expiresIn: 900 });

    const { fetch, calls } = fakeFetch([json({}, { status: 401 })]);
    const api = new MarketplaceApi(
      new Client({ baseUrl: "https://api.test", fetch, auth, retry: { ...instant, attempts: 1 } }),
    );

    await assert.rejects(api.search("x"), (e: unknown) => e instanceof UnauthorizedError);
    assert.equal(calls.length, 2, "the client kept refreshing against a token that is not working");
  });

  /**
   * The bug this whole class exists for. A screen opens, fires six
   * requests, all six get 401, and six refreshes go out. Against a server
   * that rotates refresh tokens the first succeeds and the rest present a
   * token that has been rotated, which is correctly read as theft and
   * ends the session. The customer is signed out by their own app.
   */
  it("refreshes once when six requests fail at the same moment", async () => {
    const { auth, refreshes } = setup();
    await auth.set({ accessToken: "old", refreshToken: "r1", expiresIn: 900 });

    await Promise.all(Array.from({ length: 6 }, () => auth.refresh()));

    assert.equal(refreshes(), 1, `the refresher was called ${refreshes()} times`);
  });

  it("gives every waiter the same tokens", async () => {
    const { auth } = setup();
    await auth.set({ accessToken: "old", refreshToken: "r1", expiresIn: 900 });

    const results = await Promise.all(Array.from({ length: 4 }, () => auth.refresh()));
    const first = results[0];
    for (const r of results) {
      assert.deepEqual(r, first);
    }
  });

  it("clears the tokens when a refresh fails, rather than looping on it", async () => {
    const storage = new MemoryTokenStorage();
    const auth = new Auth(storage, async () => {
      throw new Error("refresh token revoked");
    });
    await auth.set({ accessToken: "a", refreshToken: "r", expiresIn: 900 });

    await assert.rejects(auth.refresh());
    assert.equal(await storage.load(), null, "a dead refresh token was kept, so every later request retries it");
  });

  it("starts a new refresh after an earlier one finished", async () => {
    const { auth, refreshes } = setup();
    await auth.set({ accessToken: "old", refreshToken: "r1", expiresIn: 900 });

    await auth.refresh();
    await auth.refresh();
    assert.equal(refreshes(), 2, "the single flight latch was never released");
  });

  it("does nothing when there is nothing to refresh", async () => {
    const { auth, refreshes } = setup();
    assert.equal(await auth.refresh(), null);
    assert.equal(refreshes(), 0);
  });

  it("sends no authorization header when signed out", async () => {
    const { fetch, calls } = fakeFetch([json({ items: [], nextCursor: null })]);
    const api = new MarketplaceApi(new Client({ baseUrl: "https://api.test", fetch, retry: instant }));

    await api.search("x");
    assert.equal(calls[0]!.headers["authorization"], undefined);
  });
});

describe("decoders", () => {
  it("accepts a good listing", () => {
    assert.equal(decodeListing(listing).id, "l1");
  });

  // `as Listing` on a parsed body is a lie the compiler believes, and the
  // first anybody knows is a crash three screens away.
  it("names the field that is wrong", () => {
    for (const [patch, expected] of [
      [{ priceCents: "48900" }, /priceCents is a string/],
      [{ title: undefined }, /title is missing/],
      [{ inStock: null }, /inStock is null/],
      [{ grade: "pristine" }, /grade is "pristine"/],
    ] as const) {
      assert.throws(() => decodeListing({ ...listing, ...patch }), expected);
    }
  });

  it("names the index of a bad item in a page", async () => {
    const { fetch } = fakeFetch([
      json({ items: [listing, { ...listing, priceCents: null }], nextCursor: null }),
    ]);
    const api = new MarketplaceApi(new Client({ baseUrl: "https://api.test", fetch, retry: instant }));

    await assert.rejects(
      api.search("x"),
      (e: unknown) => e instanceof DecodeError && /items\[1\]\.priceCents/.test(e.message),
    );
  });

  it("refuses a page that is not a page", async () => {
    const { fetch } = fakeFetch([json({ items: "not an array" })]);
    const api = new MarketplaceApi(new Client({ baseUrl: "https://api.test", fetch, retry: instant }));

    await assert.rejects(api.search("x"), (e: unknown) => e instanceof DecodeError);
  });

  it("does not retry a decode failure", async () => {
    const { fetch, calls } = fakeFetch([json({ items: [{ broken: true }], nextCursor: null })]);
    const api = new MarketplaceApi(new Client({ baseUrl: "https://api.test", fetch, retry: instant }));

    await assert.rejects(api.search("x"), (e: unknown) => e instanceof DecodeError);
    assert.equal(calls.length, 1, "a response the client cannot read was fetched again");
  });
});

describe("backoff", () => {
  it("spreads retries across the whole interval", async () => {
    const { backoffMs } = await import("../src/retry.js");
    const policy: RetryPolicy = { ...instant, baseMs: 100, maxMs: 10_000 };

    const seen = new Set<number>();
    let rnd = 0;
    const p = { ...policy, random: () => (rnd = (rnd + 0.137) % 1) };
    for (let i = 0; i < 50; i += 1) seen.add(backoffMs(2, p));

    // Full jitter rather than exponential plus noise. Clients
    // synchronised by an outage all retry at the same computed moment
    // otherwise, and knock the server over again as it comes back.
    assert.ok(seen.size > 20, `only ${seen.size} distinct waits, so the retries are synchronised`);
    for (const ms of seen) {
      assert.ok(ms >= 0 && ms <= 400, `${ms} is outside the interval`);
    }
  });

  it("is capped", async () => {
    const { backoffMs } = await import("../src/retry.js");
    const p: RetryPolicy = { ...instant, baseMs: 1000, maxMs: 5000, random: () => 1 };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      assert.ok(backoffMs(attempt, p) <= 5000);
    }
  });
});
