import type { ClientSession } from "mongodb";
import { LIVE_SCOPE, METRIC_BUCKET_MS, RETENTION } from "@/shared/constants";
import type { WebsiteEvent } from "@/shared/event-schema";
import { floorTo } from "@/shared/time";
import type { Collections } from "../collections";
import { parseRecord, type MessageRecord, type ProcessOutcome } from "./records";
import { claim, dedupeId, rejectedId, runIdempotent, type MongoEnv, type Rejection } from "./shared";

/**
 * Where the analytics effects go.
 * - live: the analytics consumer group writes the live result set (and stores raw events).
 * - replay: a replay run writes an isolated result set under its own scope and its own
 *   deduplication group; it stores no raw events and creates no alerts.
 */
export type AnalyticsTarget =
  | { kind: "live"; groupId: string }
  | { kind: "replay"; groupId: string; runId: string; expireAt: Date };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function scopeOf(target: AnalyticsTarget): string {
  return target.kind === "live" ? LIVE_SCOPE : target.runId;
}

function expiry(target: AnalyticsTarget, eventTimeMs: number): Date {
  return target.kind === "replay" ? target.expireAt : new Date(eventTimeMs + RETENTION.historyHours * HOUR_MS);
}

/** All database effects of one event. Runs inside the caller's transaction. */
async function applyEvent(
  c: Collections,
  session: ClientSession,
  target: AnalyticsTarget,
  event: WebsiteEvent,
  record: MessageRecord,
  now: Date,
): Promise<void> {
  const scope = scopeOf(target);
  const eventTime = Date.parse(event.timestamp);
  const bucketMs = floorTo(eventTime, METRIC_BUCKET_MS);
  const bucket = new Date(bucketMs);
  const expireAt = expiry(target, bucketMs);

  if (target.kind === "live") {
    await c.events.updateOne(
      { _id: event.eventId },
      {
        $setOnInsert: {
          type: event.type,
          timestamp: new Date(eventTime),
          sessionId: event.sessionId,
          page: event.page,
          ...(event.productId ? { productId: event.productId } : {}),
          source: event.source,
          partition: record.partition,
          offset: record.offset,
          processedAt: now,
          expireAt,
        },
      },
      { upsert: true, session },
    );
  }

  await c.metricBuckets.updateOne(
    { _id: `${scope}|${bucketMs}` },
    { $inc: { [event.type]: 1 }, $setOnInsert: { scope, bucket, expireAt } },
    { upsert: true, session },
  );

  // Only clicks and cart additions are per-product metrics. Without this guard any other
  // product-carrying type (remove_from_cart) would be counted as a cart addition.
  if (event.productId && (event.type === "product_click" || event.type === "add_to_cart")) {
    await c.productBuckets.updateOne(
      { _id: `${scope}|${bucketMs}|${event.productId}` },
      {
        $inc: event.type === "product_click" ? { clicks: 1 } : { cartAdds: 1 },
        $setOnInsert: { scope, bucket, productId: event.productId, expireAt },
      },
      { upsert: true, session },
    );
  }

  await c.sessions.updateOne(
    { _id: `${scope}|${event.sessionId}` },
    {
      $min: { firstSeen: new Date(eventTime) },
      $max: { lastSeen: new Date(eventTime), expireAt: target.kind === "replay" ? target.expireAt : expiry(target, eventTime) },
      $setOnInsert: { scope, sessionId: event.sessionId },
    },
    { upsert: true, session },
  );

  if (target.kind === "replay") {
    await c.replayJobs.updateOne(
      { _id: target.runId },
      {
        $inc: { processed: 1 },
        $min: { firstEventAt: new Date(eventTime) },
        $max: { lastEventAt: new Date(eventTime) },
      },
      { session },
    );
  }
}

/**
 * Handles a malformed message: it is recorded as rejected (live) or counted on the job
 * (replay), deduplicated like any other message, and then skipped. Never throws on bad data.
 */
export async function recordRejection(
  env: MongoEnv,
  target: { groupId: string; runId?: string; expireAt?: Date },
  record: MessageRecord,
  rejection: Rejection,
  now: Date = new Date(),
): Promise<ProcessOutcome> {
  await runIdempotent(env, async (session, c) => {
    const expireAt = target.expireAt ?? new Date(now.getTime() + RETENTION.rejectedDays * DAY_MS);
    const isNew = await claim(
      c,
      session,
      rejectedId(target.groupId, record),
      { groupId: target.groupId, kind: "rejected", partition: record.partition, offset: record.offset, expireAt },
      now,
    );
    if (!isNew) return;
    if (target.runId) {
      await c.replayJobs.updateOne({ _id: target.runId }, { $inc: { rejected: 1 } }, { session });
    } else {
      await c.rejected.updateOne(
        { _id: rejectedId(target.groupId, record) },
        {
          $setOnInsert: {
            groupId: target.groupId,
            partition: record.partition,
            offset: record.offset,
            reason: rejection.reason,
            preview: rejection.preview,
            at: now,
            expireAt,
          },
        },
        { upsert: true, session },
      );
    }
  });
  return { status: "rejected", reason: rejection.reason };
}

/**
 * Processes one Kafka message for the analytics results, exactly once in effect.
 *
 * The dedupe claim and every result update commit atomically in one transaction, so a
 * redelivered message (after a crash, rebalance, or offset reset) changes nothing.
 * The caller commits the Kafka offset only after this resolves.
 */
export async function processAnalyticsMessage(
  env: MongoEnv,
  target: AnalyticsTarget,
  record: MessageRecord,
  now: Date = new Date(),
): Promise<ProcessOutcome> {
  const parsed = parseRecord(record, now.getTime());
  if (!parsed.ok) {
    return recordRejection(
      env,
      target.kind === "replay"
        ? { groupId: target.groupId, runId: target.runId, expireAt: target.expireAt }
        : { groupId: target.groupId },
      record,
      parsed,
      now,
    );
  }

  const { event } = parsed;
  return runIdempotent(env, async (session, c): Promise<ProcessOutcome> => {
    const dedupeExpiry =
      target.kind === "replay" ? target.expireAt : new Date(now.getTime() + RETENTION.dedupeDays * DAY_MS);
    const isNew = await claim(
      c,
      session,
      dedupeId(target.groupId, event.eventId),
      { groupId: target.groupId, kind: "event", partition: record.partition, offset: record.offset, expireAt: dedupeExpiry },
      now,
    );
    if (!isNew) return { status: "duplicate", eventId: event.eventId };
    await applyEvent(c, session, target, event, record, now);
    return { status: "applied", eventId: event.eventId };
  });
}
