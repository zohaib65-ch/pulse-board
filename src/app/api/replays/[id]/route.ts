import { z } from "zod";
import { requestDb } from "@/lib/server/context";
import { invalid, ok, parseQuery, route } from "@/lib/server/http";
import { getReplayDetail } from "@/lib/server/queries/replay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route<{ params: Promise<{ id: string }> }>(async (request, context) => {
  parseQuery(request, z.strictObject({}));
  const { id } = await context.params;
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw invalid("Replay ids are UUIDs.", parsed.error);
  const db = await requestDb();
  return ok(await getReplayDetail(db, parsed.data));
});
