import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSUMER_GROUP_IDS, REPLAY } from "@/shared/constants";
import { collections } from "@/lib/server/collections";
import { consumeBatch } from "@/lib/server/processing/consume";
import { claimReplayJob, createReplayJob } from "@/lib/server/replay-jobs";
import { getReplayDetail } from "@/lib/server/queries/replay";
import { GroupConsumer, type GroupConsumerOptions } from "../workers/group-consumer";
import { ReplayRunner } from "../workers/replay-runner";
import { WorkerState } from "../workers/worker-state";
import { createTestDb } from "./helpers/db";
import { makeEvent, toMessages } from "./helpers/events";
import { FakeKafka, fakeAdmin, sleep, waitFor, type FakeConsumer } from "./helpers/fake-kafka";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());

const okOutcome: GroupConsumerOptions["handle"] = async () => ({ status: "applied", eventId: "x" });
/** Resolves within `ms` or fails the test: a hang is the bug these tests exist to catch. */
const within = <T>(promise: Promise<T>, ms: number, what: string) =>
  Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error(`${what} still pending after ${ms} ms`)))]);

function groupConsumer(kafka: FakeKafka, state = new WorkerState(), handle: GroupConsumerOptions["handle"] = okOutcome) {
  const consumer = new GroupConsumer({ key: "analytics", groupId: CONSUMER_GROUP_IDS.analytics, kafka: kafka.asKafka(), mongo: t, state, handle });
  return { consumer, state };
}

describe("group consumer lifecycle", () => {
  it("stops promptly even when stop() arrives while the consumer is still starting", async () => {
    const kafka = new FakeKafka(() => ({ connectMs: 100, runMs: 400 }));
    const { consumer } = groupConsumer(kafka);
    consumer.start();
    await sleep(150); // mid-start: connected, still inside consumer.run()
    await within(consumer.stop(), 5000, "stop()");
    expect(kafka.consumers[0].calls).toContain("disconnect");
  });

  it("disconnects a consumer whose setup failed, exposes only a generic error, and keeps retrying", async () => {
    const kafka = new FakeKafka((index) => (index === 0 ? { failSubscribe: "subscribe failed: getaddrinfo ENOTFOUND kafka-secret.aivencloud.com" } : {}));
    const { consumer, state } = groupConsumer(kafka);
    consumer.start();
    expect(await waitFor(() => kafka.consumers[0]?.calls.includes("disconnect"))).toBe(true); // no leaked connection
    expect(state.groups.analytics.state).toBe("error");
    expect(state.groups.analytics.lastError).toBe("Could not reach Kafka or MongoDB.");
    expect(JSON.stringify(state.groups)).not.toContain("aivencloud");
    await within(consumer.stop(), 5000, "stop() during backoff");
  });

  it("pausing halts a batch mid-way without resolving the rest, pauses the partition, and reports paused", async () => {
    const kafka = new FakeKafka();
    const handled: string[] = [];
    const state = new WorkerState();
    const { consumer } = groupConsumer(kafka, state, async (_env, record) => {
      handled.push(record.offset);
      if (record.offset === "11") state.desiredPaused.analytics = true; // operator pauses mid-batch
      return { status: "applied", eventId: record.offset };
    });
    consumer.start();
    await waitFor(() => kafka.consumers[0]?.eachBatch !== undefined);
    const fake = kafka.consumers[0];

    await fake.deliver(0, toMessages([makeEvent(), makeEvent(), makeEvent(), makeEvent()], { startOffset: 10 }));
    expect(handled).toEqual(["10", "11"]);
    expect(fake.resolved).toEqual(["10", "11"]); // 12 and 13 stay unresolved: Kafka re-delivers them after resume
    expect(fake.commits.map((c) => c.offset)).toEqual(["11", "12"]);
    expect(fake.calls).toContain("batch-pause");
    expect(state.groups.analytics.state).toBe("paused");
    await consumer.stop();
  });

  it("applies the persisted desired state to the live consumer in both directions", async () => {
    const kafka = new FakeKafka();
    const { consumer, state } = groupConsumer(kafka);
    consumer.start();
    await waitFor(() => kafka.consumers[0]?.eachBatch !== undefined);
    const fake = kafka.consumers[0];
    fake.emit(fake.events.GROUP_JOIN, { memberAssignment: { "website-events": [1, 0] } });
    expect(state.groups.analytics.partitions).toEqual([0, 1]);
    expect(state.groups.analytics.state).toBe("running");

    state.desiredPaused.analytics = true;
    await consumer.reconcilePause();
    expect(fake.calls).toContain("pause");
    expect(state.groups.analytics.state).toBe("paused");

    state.desiredPaused.analytics = false;
    await consumer.reconcilePause();
    expect(fake.calls).toContain("resume");
    expect(state.groups.analytics.state).toBe("running");
    await consumer.stop();
  });

  it("stops consuming mid-batch when shutdown starts, leaving later messages unresolved", async () => {
    const result = await consumeBatch({
      messages: toMessages([makeEvent(), makeEvent(), makeEvent()]),
      isPaused: () => false,
      isRunning: (() => {
        let calls = 0;
        return () => ++calls <= 1;
      })(),
      handle: async () => ({ status: "applied" as const, eventId: "x" }),
      resolveOffset: () => undefined,
      commit: async () => undefined,
      heartbeat: async () => undefined,
    });
    expect(result).toEqual({ handled: 1, stopReason: "stopped" });
  });
});

describe("replay runner", () => {
  async function claimJob() {
    // Only one active job may exist: finish whatever an earlier test left behind.
    await collections(t.db).replayJobs.updateMany({ active: true }, { $set: { status: "failed" }, $unset: { active: "" } });
    const created = await createReplayJob(t.db);
    const state = new WorkerState();
    const job = (await claimReplayJob(t.db, state.instanceId))!;
    expect(job._id).toBe(created.id);
    return { job, state };
  }

  const runner = (state: WorkerState, kafka: FakeKafka, admin: ReturnType<typeof fakeAdmin>) =>
    new ReplayRunner(kafka.asKafka(), admin as never, t, state);

  const message = (offset: number, value: unknown) => ({
    offset: String(offset),
    value: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
  });

  it("reads each partition up to its captured end, then completes, disconnects, and deletes its group", async () => {
    const { job, state } = await claimJob();
    const live = await collections(t.db).events.countDocuments({});
    const duplicate = makeEvent({ type: "add_to_cart", productId: "grove-plant-pot" });
    const p0 = [makeEvent(), duplicate, duplicate, makeEvent({ type: "product_click", productId: "cedar-notebook" })];
    const p1 = [makeEvent(), "{not json"];
    const kafka = new FakeKafka(() => ({
      feed: async (consumer: FakeConsumer) => {
        await consumer.deliver(0, [...p0.map((e, i) => message(i, e)), message(4, makeEvent())]); // offset 4 is past the captured end
        await consumer.deliver(1, p1.map((e, i) => message(i, e)));
      },
    }));
    const admin = fakeAdmin({ offsets: [{ partition: 0, low: "0", high: "4" }, { partition: 1, low: "0", high: "2" }] });

    await within(runner(state, kafka, admin).runJob(job), 10_000, "runJob");

    const detail = await getReplayDetail(t.db, job._id);
    expect(detail.job).toMatchObject({ status: "completed", progress: 1, processed: 4, rejected: 1, truncated: false });
    expect(detail.job.partitions.map((p) => [p.partition, p.startOffset, p.endOffset, p.position])).toEqual([
      [0, "0", "4", "4"],
      [1, "0", "2", "2"],
    ]);
    expect(kafka.consumers).toHaveLength(1);
    expect(kafka.consumers[0].config.groupId).toBe(job.groupId);
    expect(job.groupId).toMatch(/^pulseboard-replay-v1-/);
    expect(kafka.consumers[0].calls).toEqual(expect.arrayContaining(["connect", "subscribe", "run", "stop", "disconnect"]));
    expect(kafka.consumers[0].commits).toEqual([]); // never commits offsets for any group
    expect(admin.deletedGroups).toEqual([job.groupId]);
    expect(await collections(t.db).events.countDocuments({})).toBe(live); // nothing written to live data
    expect(state.replay).toBeNull();
  });

  it("completes an empty topic without reading anything", async () => {
    const { job, state } = await claimJob();
    const kafka = new FakeKafka();
    const admin = fakeAdmin({ offsets: [{ partition: 0, low: "7", high: "7" }, { partition: 1, low: "0", high: "0" }] });
    await within(runner(state, kafka, admin).runJob(job), 5000, "runJob");
    expect((await getReplayDetail(t.db, job._id)).job).toMatchObject({ status: "completed", processed: 0, progress: 1 });
    expect(kafka.consumers).toHaveLength(0); // nothing to read, so no consumer was created
  });

  it("an interruption during startup returns the job to the queue without using up an attempt, and cleans up", async () => {
    const { job, state } = await claimJob();
    const kafka = new FakeKafka(() => ({ connectMs: 50, runMs: 1500 }));
    const admin = fakeAdmin({ offsets: [{ partition: 0, low: "0", high: "10" }] });
    const r = runner(state, kafka, admin);
    const running = r.runJob(job);
    await waitFor(() => kafka.consumers.length === 1);
    await sleep(100); // inside connect/subscribe/run, the window where the abort used to be lost
    await within(r.stop(), 5000, "stop()");
    await within(running, 5000, "runJob");

    const stored = await collections(t.db).replayJobs.findOne({ _id: job._id });
    expect(stored).toMatchObject({ status: "queued", attempt: job.attempt - 1, lease: null });
    expect(kafka.consumers[0].calls).toContain("disconnect");
    expect(admin.deletedGroups).toEqual([job.groupId]);
    expect(state.replay).toBeNull();
  });

  it("an interruption that lands before reading starts (while boundaries are captured) is not lost", async () => {
    const { job, state } = await claimJob();
    const kafka = new FakeKafka(() => ({ runMs: 5000 })); // would hang for 5 s if the abort were missed
    const admin = fakeAdmin({ offsets: [{ partition: 0, low: "0", high: "10" }] });
    const slowAdmin = { ...admin, fetchTopicOffsets: async () => { await sleep(300); return admin.fetchTopicOffsets(); } };
    const r = new ReplayRunner(kafka.asKafka(), slowAdmin as never, t, state);
    const running = r.runJob(job);
    await sleep(100); // abort fires while captureBoundaries is still waiting
    await within(r.stop(), 5000, "stop()");
    await within(running, 5000, "runJob");
    const stored = await collections(t.db).replayJobs.findOne({ _id: job._id });
    expect(stored).toMatchObject({ status: "queued", attempt: job.attempt - 1, lease: null });
  });

  it("a failure is retried with a generic public error, never raw driver text", async () => {
    const { job, state } = await claimJob();
    const kafka = new FakeKafka(() => ({ failConnect: "connect ECONNREFUSED 10.1.2.3:9093 broker-secret.example.com" }));
    const admin = fakeAdmin({ offsets: [{ partition: 0, low: "0", high: "3" }] });
    await within(runner(state, kafka, admin).runJob(job), 5000, "runJob");
    const detail = await getReplayDetail(t.db, job._id);
    expect(detail.job.status).toBe("queued"); // attempts remain, so it will be retried
    expect(detail.job.error).toBe("Could not reach Kafka or MongoDB.");
    expect(JSON.stringify(detail)).not.toMatch(/10\.1\.2\.3|broker-secret/);
    expect(kafka.consumers[0].calls).toContain("disconnect");
  });

  it("resumes after the saved position and never moves progress backwards", async () => {
    const { job, state } = await claimJob();
    const events = Array.from({ length: 5 }, () => makeEvent());
    // An earlier attempt wrote offsets 0..2; positions were saved at 3 with boundaries 0..5.
    await collections(t.db).replayJobs.updateOne(
      { _id: job._id },
      { $set: { partitions: [{ partition: 0, startOffset: "0", endOffset: "5", position: "3" }], processed: 3 } },
    );
    const resumed = (await collections(t.db).replayJobs.findOne({ _id: job._id }))!;
    let savedWhileSkipping: string | undefined;
    const kafka = new FakeKafka(() => ({
      feed: async (consumer: FakeConsumer) => {
        // The new group re-reads from the start. First only messages below the saved position...
        await consumer.deliver(0, events.slice(0, 2).map((e, i) => message(i, e)));
        await sleep(REPLAY.progressFlushMs + 500); // ...give the progress loop time to persist...
        savedWhileSkipping = (await collections(t.db).replayJobs.findOne({ _id: job._id }))?.partitions[0].position;
        await consumer.deliver(0, events.slice(2).map((e, i) => message(i + 2, e))); // ...then the rest
      },
    }));
    const admin = fakeAdmin({ offsets: [{ partition: 0, low: "0", high: "5" }] });
    await within(runner(state, kafka, admin).runJob(resumed), 10_000, "runJob");
    expect(savedWhileSkipping).toBe("3"); // skipping already-written messages must not drag progress back to 1 or 2

    const detail = await getReplayDetail(t.db, job._id);
    expect(detail.job.status).toBe("completed");
    expect(detail.job.processed).toBe(3 + 2); // only offsets 3 and 4 were applied now
    expect(detail.job.partitions[0].position).toBe("5");
    expect(detail.job.progress).toBe(1);
  });

  it("a truncated job never reports negative progress while skipping messages before its start", async () => {
    const { job, state } = await claimJob();
    await collections(t.db).replayJobs.updateOne(
      { _id: job._id },
      { $set: { truncated: true, partitions: [{ partition: 0, startOffset: "3", endOffset: "5", position: "3" }] } },
    );
    const resumed = (await collections(t.db).replayJobs.findOne({ _id: job._id }))!;
    const seen: number[] = [];
    let savedWhileSkipping: string | undefined;
    const kafka = new FakeKafka(() => ({
      feed: async (consumer: FakeConsumer) => {
        await consumer.deliver(0, Array.from({ length: 2 }, (_, i) => message(i, makeEvent()))); // before the truncation point
        await sleep(REPLAY.progressFlushMs + 500);
        savedWhileSkipping = (await collections(t.db).replayJobs.findOne({ _id: job._id }))?.partitions[0].position;
        await consumer.deliver(0, Array.from({ length: 3 }, (_, i) => message(i + 2, makeEvent())));
        seen.push(...consumer.resolved.map(Number));
      },
    }));
    await within(runner(state, kafka, fakeAdmin({ offsets: [{ partition: 0, low: "0", high: "5" }] })).runJob(resumed), 10_000, "runJob");
    expect(savedWhileSkipping).toBe("3"); // never below the start offset, so progress can never be negative
    const detail = await getReplayDetail(t.db, job._id);
    expect(detail.job).toMatchObject({ status: "completed", processed: 2, truncated: true });
    expect(detail.job.partitions[0].position).toBe("5");
    expect(REPLAY.maxMessages).toBeGreaterThan(2);
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });
});
