import { RATE_LIMITS } from "@/shared/constants";
import { requireAdmin } from "@/lib/server/auth";
import { requestDb } from "@/lib/server/context";
import { ok, parseJsonBody, parseQuery, route } from "@/lib/server/http";
import { listReplays } from "@/lib/server/queries/replay";
import { clientKey, enforce } from "@/lib/server/rate-limit";
import { createReplayJob } from "@/lib/server/replay-jobs";
import { replayCreateBody } from "@/lib/server/schemas";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (request) => {
  parseQuery(request, z.strictObject({}));
  const db = await requestDb();
  return ok(await listReplays(db));
});

/**
 * Admin-only. Creates a replay job in MongoDB and returns immediately (202); a background
 * worker claims and runs it. The API never reads Kafka itself.
 */
export const POST = route(async (request) => {
  const db = await requestDb();
  await requireAdmin(request, db);
  await enforce(db, `control:${clientKey(request)}`, RATE_LIMITS.control);
  await parseJsonBody(request, replayCreateBody, 1024);
  return ok(await createReplayJob(db), 202);
});
