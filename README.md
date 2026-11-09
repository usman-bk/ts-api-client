# ts-api-client

_Built with AI assistance._

The API client a React Native app uses: typed, retrying only what is safe
to retry, and refreshing its token exactly once.

TypeScript 5.7 in strict mode, Node 22, **no runtime dependencies**. The
tests are `node:test` against an injected `fetch`.

```
src/errors.ts   errors the app can branch on
src/retry.ts    full jitter backoff, and what may be repeated
src/auth.ts     single flight token refresh
src/client.ts   timeouts, cancellation, 401 handling
src/api.ts      the endpoints, and decoders at the boundary
```

## Refreshing once, not six times

A screen opens and fires six requests. The access token has just expired,
so all six come back 401, and six refreshes go out at once.

Against a server that rotates refresh tokens, the first succeeds and the
other five present a token that has already been rotated. The server reads
that correctly as a stolen token and revokes the session. **The customer is
signed out by their own app**, on a screen that opened normally, and it
reproduces about one time in twenty.

So the refresh is single flight. The first caller does it, the rest wait
for its result.

The subtle part is where the latch is set:

```ts
// wrong, and it looks right
if (this.inFlight) return this.inFlight;
const current = await this.storage.load();   // yields here
this.inFlight = ...
```

Every concurrent caller runs the synchronous prefix, finds `inFlight`
still null, and yields at the load. All six then start their own refresh.
It is single flight that is not.

The assignment has to happen before anything is awaited. That was a real
bug in this code, and the test for four concurrent callers getting one
answer is what found it.

## Retrying only what is safe

`isRetryable` is a property of the error, not a guess at the call site:

| | retryable |
|---|---|
| offline, timeout, 5xx, 429 | yes |
| 4xx, decode failure, cancelled | no |

A 404 retried three times is one bad request turned into three. A decode
failure retried is a response the client already could not read, fetched
again.

**Idempotency is the caller's promise, not the method's.** A GET repeats
safely. A POST that creates an order does not, and retrying it after a
timeout is how somebody is charged twice. So a non-GET is only retried if
the caller says it is safe or it carries an `Idempotency-Key`.

When it does carry one, **the same key goes out on every attempt**. A
regenerated key makes the retry a different request, which is worse than
having no key at all because it looks deliberate.

`addToBasket` generates its own key per call. `placeOrder` does not, and
takes one: the key has to be stable across a retry the caller makes after
the app is reopened, and only the caller knows that this is the same order
the customer was trying to place five minutes ago.

## Full jitter

```
wait = random(0, min(maxMs, baseMs * 2^attempt))
```

Plain exponential backoff is the version everybody writes, and it has a
failure mode that only appears at scale: a server comes back after an
outage, every client that was waiting retries at the same computed moment,
and the server falls over again. The outage synchronised the clients and
the backoff keeps them synchronised.

Randomising the whole interval rather than adding noise to it spreads them
properly. There is a test that fifty draws produce more than twenty
distinct waits.

A 429 is obeyed rather than backed off. The server has said when to come
back, in `Retry-After`, and guessing instead is both ruder and less
effective. The header is read as seconds or as an HTTP date, because both
are allowed and both turn up.

## Decoders, not casts

```ts
const listing = JSON.parse(body) as Listing;   // a lie the compiler believes
```

That says the field is a string and leaves the server free to stop sending
it. The first anybody knows is a crash in a component three screens away,
with a stack that does not mention the API.

A decoder turns it into a `DecodeError` at the boundary, naming the field:

    page.items[1].priceCents is null, expected a number

They are written by hand. Generating them from a schema is the right answer
at scale and brings a build step, a schema to keep current and a generator
to upgrade; for a dozen endpoints the hand written ones are shorter and say
what they mean.

An unknown enum value is refused rather than passed through, which is a
deliberate choice: the server has added a grade this app version predates,
and a screen rendering a grade it has no label or colour for is worse than
a clean failure.

## Timeouts and cancellation

The caller's signal and the client's timeout are combined into one
controller, so whichever fires first aborts the request and neither leaks
a timer.

A cancelled request reports `CancelledError` and a timed out one reports
`TimeoutError`, because an app shows a retry button for one of those and
nothing at all for the other.

A signal that has **already** aborted is checked before the listener is
attached, since a dead signal never fires one. Without that check a request
made just after a screen closed waits for the full ten second timeout. That
was also a real bug here, found by the cancellation test hanging.

## Running the tests

    npm test     32 cases, no server

Everything runs against an injected `fetch`, so there is no server and no
network. The fake rejects when its signal aborts, which real `fetch` does
and which a fake that forgets will hang on rather than fail: the suite ran
for ten minutes before that was fixed.

## Missing on purpose

**No request coalescing.** Two screens asking for the same listing at the
same moment make two requests. Worth adding, and it belongs next to the
cache rather than here.

**No offline queue.** A failed write is the caller's problem. Queuing
writes until the network returns is a real feature and a much larger one,
because it needs persistence and a conflict story.

**No response caching.** Nothing here remembers anything between calls.

**`expiresIn` is trusted.** The client refreshes thirty seconds before the
server said the token expires, and does not read the token to check.
