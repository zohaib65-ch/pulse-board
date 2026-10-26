import { RETENTION, SPIKE_RULE } from "@/shared/constants";
import { floorTo } from "@/shared/time";
import { parseRecord, type MessageRecord, type ProcessOutcome } from "./records";
import { recordRejection } from "./analytics";
import { claim, dedupeId, runIdempotent, type MongoEnv } from "./shared";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Spike detection for the alerts consumer group.
 *
 * Rule: more than SPIKE_RULE.eventsPerSessionPerWindow events from one session inside one
 * tumbling one-minute window (by event timestamp) raises exactly one alert for that
 * session and window. The alert id is derived from (session, window) and written with
 * $setOnInsert, so neither redelivery nor extra events past the threshold can duplicate it.
 */
export async function processAlertsMessage(
  env: MongoEnv,
  groupId: string,
  record: MessageRecord,
  now: Date = new Date(),
): Promise<ProcessOutcome> {
  const parsed = parseRecord(record, now.getTime());
  if (!parsed.ok) return recordRejection(env, { groupId }, record, parsed, now);

  const { event } = parsed;
  const eventTime = Date.parse(event.timestamp);
  const windowStartMs = floorTo(eventTime, SPIKE_RULE.windowMs);
  const windowStart = new Date(windowStartMs);
  const windowEnd = new Date(windowStartMs + SPIKE_RULE.windowMs);
  const expireAt = new Date(windowStartMs + RETENTION.alertDays * DAY_MS);

  return runIdempotent(env, async (session, c): Promise<ProcessOutcome> => {
    const isNew = await claim(
      c,
      session,
      dedupeId(groupId, event.eventId),
      {
        groupId,
        kind: "event",
        partition: record.partition,
        offset: record.offset,
        expireAt: new Date(now.getTime() + RETENTION.dedupeDays * DAY_MS),
      },
      now,
    );
    if (!isNew) return { status: "duplicate", eventId: event.eventId };

    const window = await c.alertWindows.findOneAndUpdate(
      { _id: `${event.sessionId}|${windowStartMs}` },
      {
        $inc: { count: 1 },
        // Anchored to processing time and pushed forward by every event: a counter must outlive
        // the burst that fills it even when the group is lagging, or a TTL sweep could reset it.
        $max: { expireAt: new Date(now.getTime() + RETENTION.alertWindowMinutes * 60_000) },
        $setOnInsert: { sessionId: event.sessionId, windowStart },
      },
      { upsert: true, returnDocument: "after", session },
    );

    let alertCreated = false;
    if (window && window.count > SPIKE_RULE.eventsPerSessionPerWindow) {
      const result = await c.alerts.updateOne(
        { _id: `spike|${event.sessionId}|${windowStartMs}` },
        {
          $setOnInsert: {
            kind: "session_spike",
            sessionId: event.sessionId,
            count: window.count,
            threshold: SPIKE_RULE.eventsPerSessionPerWindow,
            windowStart,
            windowEnd,
            createdAt: now,
            triggerEventId: event.eventId,
            expireAt,
          },
        },
        { upsert: true, session },
      );
      alertCreated = result.upsertedCount === 1;
    }
    return { status: "applied", eventId: event.eventId, alertCreated };
  });
}
