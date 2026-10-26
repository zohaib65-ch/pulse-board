import { RATE_LIMITS } from "@/shared/constants";
import type { AdminVerifyData } from "@/shared/api";
import { requireAdmin } from "@/lib/server/auth";
import { requestDb } from "@/lib/server/context";
import { ok, route } from "@/lib/server/http";
import { clientKey, enforce } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lets the UI check an entered token for real. Succeeds only with the correct ADMIN_TOKEN. */
export const POST = route(async (request) => {
  const db = await requestDb();
  await requireAdmin(request, db);
  await enforce(db, `control:${clientKey(request)}`, RATE_LIMITS.control);
  const data: AdminVerifyData = { verified: true };
  return ok(data);
});
