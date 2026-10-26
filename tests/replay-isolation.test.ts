import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSUMER_GROUP_IDS, LIVE_SCOPE, REPLAY, SPIKE_RULE } from "@/shared/constants";
import { collections } from "@/lib/server/collections";
import { ApiError } from "@/lib/server/errors";
import { processAlertsMessage } from "@/lib/server/processing/alerts";
import { processAnalyticsMessage, type AnalyticsTarget } from "@/lib/server/processing/analytics";
import { getOverview } from "@/lib/server/queries/overview";
import { getReplayDetail } from "@/lib/server/queries/replay";
import { claimReplayJob, completeJob, createReplayJob, releaseJob, renewLease, saveBoundaries } from "@/lib/server/replay-jobs";
import { createTestDb } from "./helpers/db";
import { makeEvent, toMessages } from "./helpers/events";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());

const liveTarget: AnalyticsTarget = { kind: "live", groupId: CONSUMER_GROUP_IDS.analytics };

async function liveSnapshot() {
  const c = collections(t.db);
  const overview = await getOverview(t.db, "24h");
  return {
    totals: overview.totals,
    breakdown: overview.breakdown,
    products: overview.topProducts,
    activeSessions: overview.activeSessions.count,
    events: await c.events.countDocuments({}),
    alerts: await c.alerts.find({}).sort({ _id: 1 }).toArray(),
    alertWindows: await c.alertWindows.countDocuments({}),
    liveBuckets: await c.metricBuckets.find({ scope: LIVE_SCOPE }).sort({ _id: 1 }).toArray(),
    liveSessions: await c.sessions.countDocuments({ scope: LIVE_SCOPE }),
    liveDedupe: await c.dedupe.countDocuments({ groupId: { $in: Object.values(CONSUMER_GROUP_IDS) } }),
    commands: await c.commands.countDocuments({}),
  };
}

describe("replay isolation", () => {
  const spikeSession = randomUUID();
  const base = Date.now() - 5 * 60_000;
  const events = [
    ...Array.from({ length: 6 }, () => makeEvent({ type: "page_view", timestamp: new Date(base).toISOString() })),
    ...Array.from({ length: 4 }, () =>
      makeEvent({ type: "product_click", productId: "grove-plant-pot", timestamp: new Date(base).toISOString() }),
    ),
    makeEvent({ type: "add_to_cart", productId: "grove-plant-pot", timestamp: new Date(base).toISOString() }),
    // 55 events from one session in one minute: spikes the live alerts group.
    ...Array.from({ length: SPIKE_RULE.eventsPerSessionPerWindow + 5 }, (_, i) =>
      makeEvent({ sessionId: spikeSession, type: "page_view", timestamp: new Date(base + 60_000 + i * 100).toISOString() }),
    ),
  ];
  const messages = toMessages(events, { partition: 0, startOffset: 0 });
  const malformed = toMessages(["{broken", JSON.stringify({ nope: true })], { partition: 1, startOffset: 40 });

  it("a replay writes only to its own result set and leaves live totals, events, buckets, sessions, alerts and dedupe records untouched", async () => {
    // Live pipeline processes the stream first.
    for (const m of messages) {
      await processAnalyticsMessage(t, liveTarget, m);
      await processAlertsMessage(t, CONSUMER_GROUP_IDS.alerts, m);
    }
    const before = await liveSnapshot();
    expect(before.totals.events).toBe(events.length);
    expect(before.alerts).toHaveLength(1);

    // Create + claim the job exactly as the API and a worker would.
    const created = await createReplayJob(t.db);
    expect(created).toMatchObject({ status: "queued", groupId: `pulseboard-replay-v1-${created.id}` });
    const job = await claimReplayJob(t.db, "worker-a");
    expect(job?._id).toBe(created.id);
    const target: AnalyticsTarget = { kind: "replay", groupId: job!.groupId, runId: job!._id, expireAt: job!.expireAt };

    // The replay reads the same retained messages (plus two malformed ones) into its own scope.
    for (const m of [...messages, ...malformed]) await processAnalyticsMessage(t, target, m);

    const detail = await getReplayDetail(t.db, created.id);
    expect(detail.job.processed).toBe(events.length);
    expect(detail.job.rejected).toBe(2);
    expect(detail.result?.totals).toEqual(before.totals); // the replay reproduces the same statistics...
    expect(detail.result?.liveTotalsForWindow).toEqual(before.totals); // ...next to unchanged live numbers
    expect(detail.result?.topProducts[0]).toMatchObject({ productId: "grove-plant-pot", clicks: 4, cartAdds: 1 });
    expect(detail.result?.sessions).toBe(await collections(t.db).sessions.countDocuments({ scope: created.id }));

    // Live data is byte-for-byte what it was. (The replay path never runs the alerts processor, so a
    // spike in the replayed stream cannot create alerts; this asserts that structurally. Kafka offsets
    // are not observable here; the worker tests assert that a replay never commits offsets.)
    expect(await liveSnapshot()).toEqual(before);

    // Results live under the run id, deduplicated by the replay's own group.
    const c = collections(t.db);
    expect(await c.metricBuckets.countDocuments({ scope: created.id })).toBeGreaterThan(0);
    expect(await c.dedupe.countDocuments({ groupId: job!.groupId, kind: "event" })).toBe(events.length);
    expect(await c.events.countDocuments({ _id: { $in: events.map((e) => e.eventId) } })).toBe(events.length); // no second copy

    // A retried attempt re-reads everything: nothing is counted twice.
    for (const m of [...messages, ...malformed]) await processAnalyticsMessage(t, target, m);
    const retried = await getReplayDetail(t.db, created.id);
    expect(retried.job.processed).toBe(events.length);
    expect(retried.job.rejected).toBe(2);
    expect(retried.result?.totals).toEqual(before.totals);
    expect(await liveSnapshot()).toEqual(before);

    await completeJob(t.db, created.id, "worker-a");
  });

  it("separate replays are isolated from each other too", async () => {
    const first = await createReplayJob(t.db);
    const claimed = await claimReplayJob(t.db, "worker-a");
    const [message] = messages;
    await processAnalyticsMessage(t, { kind: "replay", groupId: claimed!.groupId, runId: first.id, expireAt: claimed!.expireAt }, message);
    await completeJob(t.db, first.id, "worker-a");

    const second = await createReplayJob(t.db);
    const claimed2 = await claimReplayJob(t.db, "worker-a");
    const outcome = await processAnalyticsMessage(t, { kind: "replay", groupId: claimed2!.groupId, runId: second.id, expireAt: claimed2!.expireAt }, message);
    expect(outcome.status).toBe("applied"); // the first run having seen it does not make it a duplicate here
    expect((await getReplayDetail(t.db, first.id)).job.processed).toBe(1);
    expect((await getReplayDetail(t.db, second.id)).job.processed).toBe(1);
    await completeJob(t.db, second.id, "worker-a");
  });
});

describe("replay job lifecycle", () => {
  it("allows one active job, claims atomically, and takes over only after the lease expires", async () => {
    const job = await createReplayJob(t.db);
    await expect(createReplayJob(t.db)).rejects.toMatchObject({ status: 409, code: "conflict" });

    const now = new Date();
    const [a, b] = await Promise.all([claimReplayJob(t.db, "worker-a", now), claimReplayJob(t.db, "worker-b", now)]);
    expect([a, b].filter(Boolean)).toHaveLength(1); // exactly one winner
    const owner = a ? "worker-a" : "worker-b";
    const other = a ? "worker-b" : "worker-a";

    expect(await claimReplayJob(t.db, other, new Date(now.getTime() + 1000))).toBeNull(); // lease still valid
    expect(await renewLease(t.db, job.id, other)).toBe(false);
    expect(await renewLease(t.db, job.id, owner, new Date(now.getTime() + 10_000))).toBe(true);

    // The owner dies: after the lease expires another worker claims the same job (attempt 2).
    const afterExpiry = new Date(now.getTime() + REPLAY.leaseMs * 3);
    const takenOver = await claimReplayJob(t.db, other, afterExpiry);
    expect(takenOver).toMatchObject({ _id: job.id, attempt: 2 });
    expect(await renewLease(t.db, job.id, owner)).toBe(false); // the old owner has lost the job

    // Boundaries are captured once; later attempts reuse them.
    const parts = [{ partition: 0, startOffset: "5", endOffset: "20", position: "5" }];
    await saveBoundaries(t.db, job.id, parts, false);
    await saveBoundaries(t.db, job.id, [{ ...parts[0], endOffset: "999" }], true);
    const saved = await collections(t.db).replayJobs.findOne({ _id: job.id });
    expect(saved?.partitions[0].endOffset).toBe("20");
    expect(saved?.truncated).toBe(false);

    // A graceful shutdown returns the job without using up an attempt.
    await releaseJob(t.db, job.id, other, { interrupted: true });
    const released = await collections(t.db).replayJobs.findOne({ _id: job.id });
    expect(released).toMatchObject({ status: "queued", attempt: 1, lease: null });

    // Repeated failures end in "failed", which frees the slot for a new job.
    let current = await claimReplayJob(t.db, "worker-c");
    for (let i = current!.attempt; i <= REPLAY.maxAttempts; i++) {
      await releaseJob(t.db, job.id, "worker-c", { error: new Error("boom") });
      current = await claimReplayJob(t.db, "worker-c");
    }
    const failed = await collections(t.db).replayJobs.findOne({ _id: job.id });
    // The stored error is shown by the public replay endpoints, so raw error text ("boom") is replaced by a generic one.
    expect(failed).toMatchObject({ status: "failed", error: "Kafka or MongoDB reported an error; see the worker logs." });
    expect(failed?.active).toBeUndefined();
    await expect(createReplayJob(t.db)).resolves.toMatchObject({ status: "queued" });
  });

  it("reports an unknown replay as 404", async () => {
    await expect(getReplayDetail(t.db, randomUUID())).rejects.toBeInstanceOf(ApiError);
  });
});
