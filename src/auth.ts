/**
 * Holding the tokens, and refreshing them exactly once.
 *
 * The failure this exists for: a screen opens and fires six requests, the
 * access token has just expired, and all six come back 401. Six refreshes
 * then go out at once. With a server that rotates refresh tokens, the
 * first succeeds and the other five present a token that has already been
 * rotated, which the server correctly reads as a stolen token and revokes
 * the session. The customer is signed out by their own app, on a screen
 * that opened normally, and it reproduces about one time in twenty.
 *
 * So the refresh is single flight: the first caller does it and the rest
 * wait for its result.
 */

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds the access token is good for, from when it was issued. */
  expiresIn: number;
}

export interface TokenStorage {
  load(): Promise<Tokens | null>;
  save(t: Tokens): Promise<void>;
  clear(): Promise<void>;
}

/** For tests and for a client that has nowhere to persist. */
export class MemoryTokenStorage implements TokenStorage {
  private tokens: Tokens | null = null;
  async load(): Promise<Tokens | null> {
    return this.tokens;
  }
  async save(t: Tokens): Promise<void> {
    this.tokens = t;
  }
  async clear(): Promise<void> {
    this.tokens = null;
  }
}

export type Refresher = (refreshToken: string) => Promise<Tokens>;

/**
 * How long before expiry a token is treated as already expired.
 *
 * Without it, a token with two seconds left is sent on a request that
 * takes three, and the 401 comes back for a token that was valid when it
 * left. Refreshing slightly early costs one extra refresh occasionally and
 * removes a whole class of confusing failure.
 */
export const EXPIRY_MARGIN_SECONDS = 30;

export class Auth {
  private inFlight: Promise<Tokens | null> | null = null;
  private issuedAt: number | null = null;
  private refreshes = 0;

  constructor(
    private readonly storage: TokenStorage,
    private readonly refresher: Refresher,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** How many times the refresher has actually been called. */
  get refreshCount(): number {
    return this.refreshes;
  }

  async currentAccessToken(): Promise<string | null> {
    const t = await this.storage.load();
    if (!t) return null;
    if (this.isFresh(t)) return t.accessToken;

    // Known to be expiring, so refresh now rather than sending it and
    // dealing with the 401.
    const next = await this.refresh();
    return next?.accessToken ?? null;
  }

  private isFresh(t: Tokens): boolean {
    if (this.issuedAt === null) return true; // loaded from storage, assume usable
    const ageSeconds = (this.now() - this.issuedAt) / 1000;
    return ageSeconds < t.expiresIn - EXPIRY_MARGIN_SECONDS;
  }

  /**
   * Refreshes, or joins the refresh already running.
   *
   * The assignment to inFlight happens before anything is awaited, and
   * that is the whole mechanism. An earlier version read the stored
   * tokens first:
   *
   *   if (this.inFlight) return this.inFlight;
   *   const current = await this.storage.load();   // <- yields here
   *   this.inFlight = ...
   *
   * Every concurrent caller ran the synchronous prefix, found inFlight
   * still null, and yielded at the load, so all of them went on to start
   * their own refresh. It is single flight that is not, and against a
   * server that rotates refresh tokens it signs the customer out. The
   * test for four concurrent callers getting one answer is what found it.
   */
  refresh(): Promise<Tokens | null> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<Tokens | null> {
    const current = await this.storage.load();
    if (!current) return null;

    this.refreshes += 1;
    try {
      const next = await this.refresher(current.refreshToken);
      await this.storage.save(next);
      this.issuedAt = this.now();
      return next;
    } catch (e) {
      // A failed refresh clears the tokens. Keeping them means every
      // later request retries a refresh that will fail again, and the
      // app sits in a loop instead of showing a sign-in screen.
      await this.storage.clear();
      this.issuedAt = null;
      throw e;
    }
  }

  async set(t: Tokens): Promise<void> {
    await this.storage.save(t);
    this.issuedAt = this.now();
  }

  async clear(): Promise<void> {
    await this.storage.clear();
    this.issuedAt = null;
  }
}
