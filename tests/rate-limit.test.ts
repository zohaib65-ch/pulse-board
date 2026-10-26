import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consume, isExhausted, release } from "@/lib/server/rate-limit";
import { tokensMatch } from "@/lib/server/auth";
import { createTestDb } from "./helpers/db";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());

describe("MongoDB-backed rate limiter", () => {
  const rule = { limit: 5, windowMs: 1000 };

  it("allows up to the limit inside a window, then refuses with a retry hint", async () => {
    const now = 1_700_000_000_250;
    const results = [];
    for (let i = 0; i < 7; i++) results.push(await consume(t.db, "unit", rule, 1, now));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, true, false, false]);
    expect(results[5].retryAfterSeconds).toBe(1);
    // A new window starts fresh.
    expect((await consume(t.db, "unit", rule, 1, now + 1000)).allowed).toBe(true);
  });

  it("is atomic under concurrency: exactly `limit` of many parallel calls succeed", async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () => consume(t.db, "race", rule, 1, 1_700_000_100_000)));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it("charges a batch as one unit and never lets a refused batch consume capacity", async () => {
    const now = 1_700_000_200_000;
    expect((await consume(t.db, "batch", rule, 4, now)).allowed).toBe(true);
    expect((await consume(t.db, "batch", rule, 4, now)).allowed).toBe(false); // would exceed 5
    expect((await consume(t.db, "batch", rule, 1, now)).allowed).toBe(true); // the refused batch took nothing
    expect((await consume(t.db, "batch", rule, 6, now + 2000)).allowed).toBe(false); // larger than the limit itself
  });

  it("can be peeked without consuming", async () => {
    const now = 1_700_000_300_000;
    expect((await isExhausted(t.db, "peek", rule, now)).allowed).toBe(true);
    for (let i = 0; i < 5; i++) await consume(t.db, "peek", rule, 1, now);
    expect((await isExhausted(t.db, "peek", rule, now)).allowed).toBe(false);
    expect((await isExhausted(t.db, "peek", rule, now + 1000)).allowed).toBe(true);
  });

  it("stores counters in MongoDB behind a TTL index, so any instance shares them and old windows are purged", async () => {
    const doc = await t.db.collection("rate_limits").findOne({ _id: { $regex: "^unit\\|" } } as never);
    expect(doc?.expireAt).toBeInstanceOf(Date);
    const indexes = await t.db.collection("rate_limits").indexes();
    expect(indexes.some((index) => index.key.expireAt === 1 && index.expireAfterSeconds === 0)).toBe(true);
  });

  it("can give capacity back", async () => {
    const now = 1_700_000_400_000;
    for (let i = 0; i < 5; i++) await consume(t.db, "refund", rule, 1, now);
    expect((await consume(t.db, "refund", rule, 1, now)).allowed).toBe(false);
    await release(t.db, "refund", rule, 1, now);
    expect((await consume(t.db, "refund", rule, 1, now)).allowed).toBe(true);
    await release(t.db, "refund-none", rule, 1, now); // releasing from an empty window is a no-op
  });
});

describe("token comparison", () => {
  it("matches only identical tokens, regardless of length", () => {
    expect(tokensMatch("a".repeat(40), "a".repeat(40))).toBe(true);
    expect(tokensMatch("a".repeat(40), "a".repeat(39))).toBe(false);
    expect(tokensMatch("", "a".repeat(40))).toBe(false);
    expect(tokensMatch("b".repeat(40), "a".repeat(40))).toBe(false);
  });
});
