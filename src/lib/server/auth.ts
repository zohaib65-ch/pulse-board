import { createHash, timingSafeEqual } from "node:crypto";
import type { Db } from "mongodb";
import { RATE_LIMITS } from "@/shared/constants";
import { getAdminToken } from "./config";
import { ApiError } from "./errors";
import { clientKey, consume, release } from "./rate-limit";

/**
 * Constant-time token comparison. Both sides are hashed first so the comparison always
 * runs over equal-length buffers and does not leak the token length.
 */
export function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Verifies `Authorization: Bearer <ADMIN_TOKEN>` for every write/control endpoint.
 *
 * Every attempt first RESERVES one slot from a per-client MongoDB window, and a correct token
 * hands the slot back. Reserving before comparing makes the cap hold under concurrency: of any
 * burst of wrong guesses, only RATE_LIMITS.authFailures.limit are ever compared; the rest get
 * 429 without being evaluated. A client that has used up its slots is refused even with the
 * correct token until the window expires.
 */
export async function requireAdmin(request: Request, db: Db): Promise<void> {
  const expected = getAdminToken();
  const key = `auth-fail:${clientKey(request)}`;

  const slot = await consume(db, key, RATE_LIMITS.authFailures);
  if (!slot.allowed) {
    throw new ApiError(429, "rate_limited", "Too many failed authentication attempts. Try again later.", {
      retryAfterSeconds: slot.retryAfterSeconds,
    });
  }

  const token = bearerToken(request);
  if (!token || !tokensMatch(token, expected)) {
    throw new ApiError(401, "unauthorized", "A valid admin token is required for this action.");
  }
  await release(db, key, RATE_LIMITS.authFailures);
}
