import type { Db } from "mongodb";
import { QUERY_LIMITS } from "@/shared/constants";
import type { AlertsData } from "@/shared/api";
import { collections } from "../collections";

export async function getAlerts(db: Db, limit: number, now: Date = new Date()): Promise<AlertsData> {
  const docs = await collections(db)
    .alerts.find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .maxTimeMS(QUERY_LIMITS.maxTimeMs)
    .toArray();
  return {
    generatedAt: now.toISOString(),
    items: docs.map((doc) => ({
      id: doc._id,
      kind: doc.kind,
      sessionId: doc.sessionId,
      count: doc.count,
      threshold: doc.threshold,
      windowStart: doc.windowStart.toISOString(),
      windowEnd: doc.windowEnd.toISOString(),
      createdAt: doc.createdAt.toISOString(),
    })),
  };
}
