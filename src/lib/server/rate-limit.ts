import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { RETENTION } from "@/shared/constants";
import { ApiError } from "./errors";
import { collections } from "./collections";
import { isDuplicateKeyError } from "./mongo";

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

function windowOf(rule: RateLimitRule, now: number) {
  const start = Math.floor(now / rule.windowMs) * rule.windowMs;
  const end = start + rule.windowMs;
  return { id: (key: string) => `${key}|${start}`, end, retryAfterSeconds: Math.max(1, Math.ceil((end - now) / 1000)) };
}

/**
 * Fixed-window limiter stored in MongoDB, so every serverless instance and worker
 * shares the same counters. The increment is conditional on `count <= limit - cost`:
 * when the window is full the upsert collides on `_id` (E11000) instead of incrementing,
 * which makes check-and-consume a single atomic operation with no read-then-write race.
 */
export async function consume(
  db: Db,
  key: string,
  rule: RateLimitRule,
  cost = 1,
  now = Date.now(),
): Promise<RateLimitResult> {
  const w = windowOf(rule, now);
  if (cost > rule.limit) return { allowed: false, retryAfterSeconds: w.retryAfterSeconds };
  try {
    await collections(db).rateLimits.updateOne(
      { _id: w.id(key), count: { $lte: rule.limit - cost } },
      {
        $inc: { count: cost },
        $setOnInsert: { expireAt: new Date(w.end + RETENTION.rateLimitGraceSeconds * 1000) },
      },
      { upsert: true },
    );
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (error) {
    if (isDuplicateKeyError(error)) return { allowed: false, retryAfterSeconds: w.retryAfterSeconds };
    throw error;
  }
}

/** Gives back capacity taken by `consume` (e.g. an attempt that turned out to be legitimate). */
export async function release(db: Db, key: string, rule: RateLimitRule, cost = 1, now = Date.now()): Promise<void> {
  const w = windowOf(rule, now);
  await collections(db).rateLimits.updateOne({ _id: w.id(key), count: { $gte: cost } }, { $inc: { count: -cost } });
}

/** Reads the current window without consuming anything. */
export async function isExhausted(db: Db, key: string, rule: RateLimitRule, now = Date.now()): Promise<RateLimitResult> {
  const w = windowOf(rule, now);
  const doc = await collections(db).rateLimits.findOne({ _id: w.id(key) });
  const exhausted = (doc?.count ?? 0) >= rule.limit;
  return { allowed: !exhausted, retryAfterSeconds: exhausted ? w.retryAfterSeconds : 0 };
}

/** Throws a 429 ApiError when the rule is exceeded. */
export async function enforce(db: Db, key: string, rule: RateLimitRule, cost = 1, message?: string): Promise<void> {
  const result = await consume(db, key, rule, cost);
  if (!result.allowed) {
    throw new ApiError(429, "rate_limited", message ?? "Too many requests. Slow down and retry.", {
      retryAfterSeconds: result.retryAfterSeconds,
    });
  }
}

/**
 * Identifies the caller without storing the address: first hop of x-forwarded-for
 * (set by the platform proxy), hashed.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || request.headers.get("x-real-ip") || "unknown";
  return createHash("sha256").update(address).digest("hex").slice(0, 16);
}
