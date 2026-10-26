import { RATE_LIMITS } from "@/shared/constants";
import { consumerActionSchema, consumerKeySchema } from "@/shared/api";
import { requireAdmin } from "@/lib/server/auth";
import { requestDb } from "@/lib/server/context";
import { setConsumerPaused } from "@/lib/server/consumer-control";
import { invalid, ok, parseJsonBody, route } from "@/lib/server/http";
import { clientKey, enforce } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-only: pause or resume a consumer group. The desired state is stored in MongoDB and
 * applied by every worker instance; ingestion into Kafka is not affected.
 */
export const POST = route<{ params: Promise<{ group: string }> }>(async (request, context) => {
  const db = await requestDb();
  await requireAdmin(request, db);

  const { group } = await context.params;
  const key = consumerKeySchema.safeParse(group);
  if (!key.success) throw invalid("Unknown consumer group.", key.error);

  await enforce(db, `control:${clientKey(request)}`, RATE_LIMITS.control);
  const { action } = await parseJsonBody(request, consumerActionSchema, 1024);
  return ok(await setConsumerPaused(db, key.data, action === "pause"));
});
