import { INGEST_LIMITS } from "@/shared/constants";
import { ingestRequestSchema } from "@/shared/event-schema";
import { requireAdmin } from "@/lib/server/auth";
import { requestDb } from "@/lib/server/context";
import { ok, parseJsonBody, parseQuery, route } from "@/lib/server/http";
import { acceptEvents } from "@/lib/server/ingest";
import { getEvents } from "@/lib/server/queries/events";
import { eventsQuery } from "@/lib/server/schemas";

// These handlers use Kafka and MongoDB, which need the Node.js runtime, and always run per request.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public, read-only: filtered, bounded, newest-first event list. */
export const GET = route(async (request) => {
  const query = parseQuery(request, eventsQuery);
  const db = await requestDb();
  return ok(await getEvents(db, query));
});

/**
 * Admin-only ingestion. Order matters: authenticate first (so anonymous callers learn nothing
 * about validation), then bound and validate the body, then rate limit, then publish.
 * Responds 202 only after Kafka has acknowledged the events.
 */
export const POST = route(async (request) => {
  const db = await requestDb();
  await requireAdmin(request, db);
  const body = await parseJsonBody(request, ingestRequestSchema, INGEST_LIMITS.maxBodyBytes);
  return ok(await acceptEvents(db, body), 202);
});
