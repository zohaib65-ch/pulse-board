import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSUMER_GROUP_IDS } from "@/shared/constants";
import { collections } from "@/lib/server/collections";
import { setConsumerPaused } from "@/lib/server/consumer-control";
import { consumeBatch, type BatchMessage } from "@/lib/server/processing/consume";
import { processAnalyticsMessage } from "@/lib/server/processing/analytics";
import { getOverview } from "@/lib/server/queries/overview";
import { getStatus } from "@/lib/server/queries/status";
import { createTestDb } from "./helpers/db";
import { makeEvent, toMessages } from "./helpers/events";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());

/** A fake consumer: records the order of apply/resolve/commit calls the way Kafka would see them. */
function harness(options: { paused?: { value: boolean }; pauseAfterApplying?: string; failCommitAt?: string } = {}) {
  const paused = options.paused ?? { value: false };
  const log: string[] = [];
  const committed: string[] = [];
  const run = (batch: BatchMessage[]) =>
    consumeBatch({
      messages: batch,
      isPaused: () => paused.value,
      isRunning: () => true,
      handle: async (record) => {
        log.push(`apply:${record.offset}`);
        const outcome = await processAnalyticsMessage(t, { kind: "live", groupId: CONSUMER_GROUP_IDS.analytics }, record);
        // An operator pauses the group right after this message has been applied.
        if (record.offset === options.pauseAfterApplying) paused.value = true;
        return outcome;
      },
      resolveOffset: (offset) => log.push(`resolve:${offset}`),
      commit: async (next) => {
        if (options.failCommitAt === next) throw new Error("simulated crash before the offset commit");
        log.push(`commit:${next}`);
        committed.push(next);
      },
      heartbeat: async () => undefined,
    });
  return { log, committed, run, paused };
}

describe("pause/resume recovery", () => {
  it("applies the pause immediately, keeps the backlog, and catches up exactly once after resume", async () => {
    const events = Array.from({ length: 10 }, () => makeEvent({ type: "page_view" }));
    const messages = toMessages(events, { partition: 0, startOffset: 100 });
    const h = harness({ pauseAfterApplying: "104" });

    // Messages 100..104 are processed, then the pause takes effect before 105 is touched.
    const firstRun = await h.run(messages);
    expect(firstRun).toEqual({ handled: 5, stopReason: "paused" });
    expect(h.committed.at(-1)).toBe("105"); // committed offset = last processed offset + 1
    expect(h.log).not.toContain("apply:105");
    expect((await getOverview(t.db, "15m")).totals.pageViews).toBe(5);

    // Ingestion continues while paused (Kafka keeps 105..109): re-offering them changes nothing.
    expect(await h.run(messages.slice(5))).toEqual({ handled: 0, stopReason: "paused" });
    expect((await getOverview(t.db, "15m")).totals.pageViews).toBe(5);

    // Resume: the next fetch starts at the first unresolved offset (105) and drains the backlog.
    h.paused.value = false;
    expect(await h.run(messages.slice(5))).toEqual({ handled: 5, stopReason: "drained" });
    expect(h.committed.at(-1)).toBe("110");
    expect((await getOverview(t.db, "15m")).totals.pageViews).toBe(10);
    expect(await collections(t.db).events.countDocuments({ _id: { $in: events.map((e) => e.eventId) } })).toBe(10);
  });

  it("applies to MongoDB strictly before committing each offset", async () => {
    const messages = toMessages([makeEvent(), makeEvent(), makeEvent()], { partition: 0, startOffset: 200 });
    const h = harness();
    await h.run(messages);
    // For every message: apply, then resolve, then commit, in that order, one message at a time.
    expect(h.log).toEqual([
      "apply:200", "resolve:200", "commit:201",
      "apply:201", "resolve:201", "commit:202",
      "apply:202", "resolve:202", "commit:203",
    ]);
  });

  it("redelivers after a crash between apply and commit without double counting", async () => {
    const events = [makeEvent(), makeEvent(), makeEvent()];
    const messages = toMessages(events, { partition: 1, startOffset: 300 });
    const before = (await getOverview(t.db, "15m")).totals.pageViews;

    const crashing = harness({ failCommitAt: "302" });
    await expect(crashing.run(messages)).rejects.toThrow(/simulated crash/);
    expect(crashing.committed).toEqual(["301"]); // 301 committed; message 301 applied but its commit (302) was lost

    // The restarted consumer resumes from the last COMMITTED offset (301) and sees message 301 again.
    const restarted = harness();
    const result = await restarted.run(messages.slice(1));
    expect(result.handled).toBe(2);
    expect((await getOverview(t.db, "15m")).totals.pageViews).toBe(before + 3); // exactly the 3 events, once
  });

  it("persists the pause command in MongoDB, the single place every worker instance reads it from", async () => {
    const commands = collections(t.db).commands;
    expect(await commands.findOne({ _id: "analytics" })).toBeNull();

    const paused = await setConsumerPaused(t.db, "analytics", true, new Date("2026-03-01T10:00:00Z"));
    expect(paused).toMatchObject({ key: "analytics", paused: true });
    // Idempotent: a repeated pause keeps the original timestamp.
    const again = await setConsumerPaused(t.db, "analytics", true, new Date("2026-03-01T10:05:00Z"));
    expect(again.updatedAt).toBe(paused.updatedAt);

    // Workers learn the state only by reading this collection, so a worker that starts later sees it too.
    const workerA = await commands.find({}).toArray();
    const workerB = await collections(t.db).commands.find({}).toArray();
    expect(workerA.find((d) => d._id === "analytics")?.paused).toBe(true);
    expect(workerB).toEqual(workerA);
    expect(workerA.find((d) => d._id === "alerts")).toBeUndefined(); // alerts group is independent

    const status = await getStatus(t.db);
    expect(status.groups.find((g) => g.key === "analytics")).toMatchObject({ paused: true, effective: "no_workers" });
    expect(status.groups.find((g) => g.key === "alerts")?.paused).toBe(false);

    await setConsumerPaused(t.db, "analytics", false);
    expect((await getStatus(t.db)).groups.find((g) => g.key === "analytics")?.paused).toBe(false);
  });

  it("reports workers honestly: fresh heartbeats drive the effective state, old ones are stale", async () => {
    const now = new Date();
    const group = (state: "running" | "paused") => ({
      state, partitions: [0], processed: 1, rejected: 0, lastProcessedAt: now, lastError: null,
    });
    await collections(t.db).workers.insertMany([
      { _id: "fresh", hostname: "a", startedAt: now, lastHeartbeatAt: now, kafkaConnected: true, replay: null, expireAt: new Date(now.getTime() + 3.6e6),
        groups: { analytics: group("paused"), alerts: group("running") } },
      { _id: "dead", hostname: "b", startedAt: now, lastHeartbeatAt: new Date(now.getTime() - 120_000), kafkaConnected: true, replay: null, expireAt: new Date(now.getTime() + 3.6e6),
        groups: { analytics: group("running"), alerts: group("running") } },
    ]);
    const status = await getStatus(t.db, now);
    expect(status.workers.find((w) => w.instanceId === "fresh")?.stale).toBe(false);
    expect(status.workers.find((w) => w.instanceId === "dead")?.stale).toBe(true);
    // The stale worker's "running" report is ignored for the effective state.
    expect(status.groups.find((g) => g.key === "analytics")?.effective).toBe("paused");
    expect(status.groups.find((g) => g.key === "alerts")?.effective).toBe("running");
    expect(status.kafka.workerConnected).toBe(true);
  });
});
