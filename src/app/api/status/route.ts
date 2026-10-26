import { requestDb } from "@/lib/server/context";
import { ok, parseQuery, route } from "@/lib/server/http";
import { getStatus } from "@/lib/server/queries/status";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (request) => {
  parseQuery(request, z.strictObject({}));
  const db = await requestDb();
  return ok(await getStatus(db));
});
