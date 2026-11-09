import { randomUUID } from "node:crypto";

import type { Client } from "./client.js";

/**
 * The endpoints, and the decoders that stand between the server and the
 * app's type definitions.
 *
 * `as T` on a parsed JSON body is a lie the compiler believes. It says the
 * field is a string and the server is free to stop sending it, and the
 * first anybody knows is a crash in a component three screens away with a
 * stack that does not mention the API. A decoder turns that into a
 * DecodeError at the boundary, naming the field.
 *
 * Written by hand rather than generated from a schema. Generating them is
 * the right answer at scale and brings a build step, a schema to keep
 * current and a generator to upgrade; for a dozen endpoints the hand
 * written ones are shorter and say what they mean.
 */

export interface Listing {
  id: string;
  title: string;
  grade: "excellent" | "good" | "fair";
  priceCents: number;
  currency: string;
  imageUrl: string;
  inStock: boolean;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface BasketLine {
  sku: string;
  qty: number;
}

function obj(raw: unknown, where: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} is ${describe(raw)}, expected an object`);
  }
  return raw as Record<string, unknown>;
}

function str(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== "string") throw new Error(`${where}.${key} is ${describe(v)}, expected a string`);
  return v;
}

function num(o: Record<string, unknown>, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${where}.${key} is ${describe(v)}, expected a number`);
  }
  return v;
}

function bool(o: Record<string, unknown>, key: string, where: string): boolean {
  const v = o[key];
  if (typeof v !== "boolean") throw new Error(`${where}.${key} is ${describe(v)}, expected a boolean`);
  return v;
}

function describe(v: unknown): string {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return `a ${typeof v}`;
}

const GRADES = new Set(["excellent", "good", "fair"]);

export function decodeListing(raw: unknown, where = "listing"): Listing {
  const o = obj(raw, where);
  const grade = str(o, "grade", where);
  if (!GRADES.has(grade)) {
    // An unknown enum value is a real event rather than a bug: the server
    // added a grade and this app predates it. Failing here is still the
    // right answer, because the alternative is a screen rendering a grade
    // it has no label or colour for.
    throw new Error(`${where}.grade is "${grade}", which this version does not know`);
  }
  return {
    id: str(o, "id", where),
    title: str(o, "title", where),
    grade: grade as Listing["grade"],
    priceCents: num(o, "priceCents", where),
    currency: str(o, "currency", where),
    imageUrl: str(o, "imageUrl", where),
    inStock: bool(o, "inStock", where),
  };
}

export function decodePage<T>(
  decodeItem: (raw: unknown, where: string) => T,
): (raw: unknown) => Page<T> {
  return (raw: unknown): Page<T> => {
    const o = obj(raw, "page");
    const items = o["items"];
    if (!Array.isArray(items)) {
      throw new Error(`page.items is ${describe(items)}, expected an array`);
    }
    const cursor = o["nextCursor"];
    if (cursor !== null && cursor !== undefined && typeof cursor !== "string") {
      throw new Error(`page.nextCursor is ${describe(cursor)}, expected a string or null`);
    }
    return {
      items: items.map((item, i) => decodeItem(item, `page.items[${i}]`)),
      nextCursor: (cursor as string | null | undefined) ?? null,
    };
  };
}

export function decodeBasket(raw: unknown): BasketLine[] {
  const o = obj(raw, "basket");
  const lines = o["cart"];
  if (!Array.isArray(lines)) {
    throw new Error(`basket.cart is ${describe(lines)}, expected an array`);
  }
  return lines.map((l, i) => {
    const line = obj(l, `basket.cart[${i}]`);
    return {
      sku: str(line, "sku", `basket.cart[${i}]`),
      qty: num(line, "qty", `basket.cart[${i}]`),
    };
  });
}

export class MarketplaceApi {
  constructor(private readonly client: Client) {}

  async search(query: string, opts: { limit?: number; cursor?: string; signal?: AbortSignal } = {}): Promise<Page<Listing>> {
    return this.client.request({
      method: "GET",
      path: "/v1/listings",
      query: { q: query, limit: opts.limit ?? 20, cursor: opts.cursor },
      decode: decodePage(decodeListing),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  async listing(id: string, opts: { signal?: AbortSignal } = {}): Promise<Listing> {
    return this.client.request({
      method: "GET",
      path: `/v1/listings/${encodeURIComponent(id)}`,
      decode: (raw) => decodeListing(raw),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  /**
   * Adds to the basket.
   *
   * The key is generated here, once per call, and the same key goes out on
   * every retry. That is what makes an unsafe request safe to repeat: the
   * server recognises the second attempt as the first one rather than
   * adding the item twice. Generating a new key per attempt would be worse
   * than having none, because it looks deliberate.
   */
  async addToBasket(
    sku: string,
    qty: number,
    opts: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<BasketLine[]> {
    return this.client.request({
      method: "POST",
      path: "/v1/basket/items",
      body: { sku, qty },
      idempotencyKey: opts.idempotencyKey ?? randomUUID(),
      decode: decodeBasket,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  /**
   * Places an order, and deliberately takes no idempotency key of its own.
   *
   * The caller supplies it, because the key has to be stable across the
   * retry the caller may do after the app is reopened, and only the caller
   * knows that this is the same order the customer was trying to place
   * five minutes ago.
   */
  async placeOrder(
    basketId: string,
    idempotencyKey: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ orderId: string }> {
    return this.client.request({
      method: "POST",
      path: "/v1/orders",
      body: { basketId },
      idempotencyKey,
      decode: (raw) => ({ orderId: str(obj(raw, "order"), "orderId", "order") }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }
}
