import type { Db } from "mongodb";
import { LIVE_SCOPE, QUERY_LIMITS } from "@/shared/constants";
import type { ReplayDetailData, ReplayJobData, ReplayListData, ReplayResultData } from "@/shared/api";
import { floorTo } from "@/shared/time";
import { collections, type ReplayJobDoc } from "../collections";
import { ApiError } from "../errors";
import { chooseBucketMs, readProductAggregates, readWindowStats, toProductRows } from "./stats";

export function toReplayJobData(doc: ReplayJobDoc): ReplayJobData {
  const total = doc.partitions.reduce((sum, p) => sum + Number(BigInt(p.endOffset) - BigInt(p.startOffset)), 0);
  const done = doc.partitions.reduce(
    (sum, p) => sum + Number(BigInt(p.position) - BigInt(p.startOffset)),
    0,
  );
  const progress = doc.status === "completed" ? 1 : total > 0 ? Math.min(1, done / total) : 0;

  return {
    id: doc._id,
    status: doc.status,
    groupId: doc.groupId,
    createdAt: doc.createdAt.toISOString(),
    startedAt: doc.startedAt?.toISOString() ?? null,
    finishedAt: doc.finishedAt?.toISOString() ?? null,
    attempt: doc.attempt,
    progress,
    partitions: doc.partitions.map(({ partition, startOffset, endOffset, position }) => ({
      partition,
      startOffset,
      endOffset,
      position,
    })),
    processed: doc.processed,
    rejected: doc.rejected,
    truncated: doc.truncated,
    error: doc.error,
    expiresAt: doc.expireAt.toISOString(),
  };
}

export async function listReplays(db: Db, now: Date = new Date()): Promise<ReplayListData> {
  const docs = await collections(db)
    .replayJobs.find({})
    .sort({ createdAt: -1 })
    .limit(QUERY_LIMITS.replayListLimit)
    .maxTimeMS(QUERY_LIMITS.maxTimeMs)
    .toArray();
  return { generatedAt: now.toISOString(), items: docs.map(toReplayJobData) };
}

/** The replay job plus statistics from its isolated result set (scope = run id). */
export async function getReplayDetail(db: Db, id: string): Promise<ReplayDetailData> {
  const doc = await collections(db).replayJobs.findOne({ _id: id });
  if (!doc) throw new ApiError(404, "not_found", "No replay with that id exists (it may have expired).");
  const job = toReplayJobData(doc);
  if (doc.processed === 0 || !doc.firstEventAt || !doc.lastEventAt) return { job, result: null };

  const fromMs = floorTo(doc.firstEventAt.getTime(), 60_000);
  const toMs = doc.lastEventAt.getTime();
  const chartBucketMs = chooseBucketMs(toMs - fromMs);

  const [stats, aggregates, sessions, live] = await Promise.all([
    readWindowStats(db, { scope: id, fromMs, toMs, chartBucketMs }),
    readProductAggregates(db, id, fromMs, toMs),
    collections(db).sessions.countDocuments({ scope: id }, { maxTimeMS: QUERY_LIMITS.maxTimeMs }),
    // Read-only: shows that live totals for the same window are untouched by the replay.
    readWindowStats(db, { scope: LIVE_SCOPE, fromMs, toMs, chartBucketMs }),
  ]);

  const result: ReplayResultData = {
    totals: stats.totals,
    sessions,
    bucketMinutes: chartBucketMs / 60_000,
    series: stats.series,
    breakdown: stats.breakdown,
    topProducts: toProductRows(aggregates).rows.slice(0, QUERY_LIMITS.topProducts),
    firstEventAt: doc.firstEventAt.toISOString(),
    lastEventAt: doc.lastEventAt.toISOString(),
    liveTotalsForWindow: live.totals,
  };
  return { job, result };
}
