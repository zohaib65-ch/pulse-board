import { requestDb } from "@/lib/server/context";
import { ok, parseQuery, route } from "@/lib/server/http";
import { getOverview } from "@/lib/server/queries/overview";
import { overviewQuery } from "@/lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (request) => {
  const { range } = parseQuery(request, overviewQuery);
  const db = await requestDb();
  return ok(await getOverview(db, range));
});
