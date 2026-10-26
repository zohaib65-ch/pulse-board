import { requestDb } from "@/lib/server/context";
import { ok, parseQuery, route } from "@/lib/server/http";
import { getAlerts } from "@/lib/server/queries/alerts";
import { alertsQuery } from "@/lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (request) => {
  const { limit } = parseQuery(request, alertsQuery);
  const db = await requestDb();
  return ok(await getAlerts(db, limit));
});
