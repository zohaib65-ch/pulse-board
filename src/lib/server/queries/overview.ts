import type { Db } from "mongodb";
import { LIVE_SCOPE, QUERY_LIMITS, RANGES, type RangeKey } from "@/shared/constants";
import type { OverviewData } from "@/shared/api";
import { rangeWindow } from "@/shared/time";
import { readActiveSessions, readProductAggregates, readWindowStats, toProductRows } from "./stats";
import { ACTIVE_SESSION_WINDOW_MINUTES } from "@/shared/constants";

export async function getOverview(db: Db, range: RangeKey, now: Date = new Date()): Promise<OverviewData> {
  const window = rangeWindow(range, now.getTime());
  const [stats, aggregates, activeSessions] = await Promise.all([
    readWindowStats(db, { scope: LIVE_SCOPE, ...window }),
    readProductAggregates(db, LIVE_SCOPE, window.fromMs, window.toMs),
    readActiveSessions(db, now.getTime()),
  ]);
  const { rows } = toProductRows(aggregates);

  return {
    range,
    from: new Date(window.fromMs).toISOString(),
    to: new Date(window.toMs).toISOString(),
    generatedAt: now.toISOString(),
    bucketMinutes: RANGES[range].chartBucketMinutes,
    totals: stats.totals,
    activeSessions: { count: activeSessions, windowMinutes: ACTIVE_SESSION_WINDOW_MINUTES },
    series: stats.series,
    breakdown: stats.breakdown,
    topProducts: rows.slice(0, QUERY_LIMITS.topProducts),
  };
}
