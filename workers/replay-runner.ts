import type { Admin, Consumer, Kafka } from "kafkajs";
import { REPLAY, TOPIC_NAME } from "@/shared/constants";
import type { ReplayPartitionProgress } from "@/shared/api";
import { collections, type ReplayJobDoc } from "@/lib/server/collections";
import { errorMessage, PublicError } from "@/lib/server/errors";
import { log } from "@/lib/server/log";
import { processAnalyticsMessage, type AnalyticsTarget } from "@/lib/server/processing/analytics";
import type { MongoEnv } from "@/lib/server/processing/shared";
import {
  claimReplayJob,
  completeJob,
  releaseJob,
  renewLease,
  saveBoundaries,
  saveProgress,
} from "@/lib/server/replay-jobs";
import { Loop } from "./util";
import type { WorkerState } from "./worker-state";

/** Thrown into a running job when the worker is shutting down. */
class Interrupted extends Error {
  constructor() {
    super("worker is shutting down");
    this.name = "Interrupted";
  }
}

interface Range {
  partition: number;
  start: bigint;
  end: bigint;
  /** Resume point: messages below this were already written to this run's results. */
  from: bigint;
  position: bigint;
}

const toRanges = (partitions: ReplayPartitionProgress[]): Range[] =>
  partitions.map((p) => ({
    partition: p.partition,
    start: BigInt(p.startOffset),
    end: BigInt(p.endOffset),
    from: BigInt(p.position),
    position: BigInt(p.position),
  }));

const toProgress = (ranges: Range[]): ReplayPartitionProgress[] =>
  ranges.map((r) => ({
    partition: r.partition,
    startOffset: r.start.toString(),
    endOffset: r.end.toString(),
    position: r.position.toString(),
  }));

/**
 * Background replay of retained Kafka events into an isolated result set.
 *
 * - The API only creates a job; this runner claims one atomically and keeps a renewable lease.
 * - Each job reads with its own temporary consumer group, never touching the live groups'
 *   offsets, and writes under its own `runId` scope with its own deduplication, so live totals
 *   and alerts are untouched and no external action can be triggered.
 * - It reads each partition from the earliest retained offset up to the end offset captured
 *   when the job started, then stops. Events Kafka has already expired cannot be replayed.
 */
export class ReplayRunner {
  private readonly claimLoop: Loop;
  private current: Promise<void> | undefined;
  private abortCurrent: AbortController | undefined;

  constructor(
    private readonly kafka: Kafka,
    private readonly admin: Admin,
    private readonly mongo: MongoEnv,
    private readonly state: WorkerState,
  ) {
    this.claimLoop = new Loop("replay-claim", REPLAY.jobPollMs, async () => {
      if (this.current || this.state.stopping) return;
      const job = await claimReplayJob(this.mongo.db, this.state.instanceId);
      if (!job) return;
      this.current = this.runJob(job).finally(() => {
        this.current = undefined;
      });
    });
  }

  start(): void {
    this.claimLoop.start();
  }

  async stop(): Promise<void> {
    await this.claimLoop.stop();
    this.abortCurrent?.abort(new Interrupted());
    await this.current;
  }

  /** Runs one claimed job to completion, failure, or interruption. Public so tests can drive it. */
  async runJob(job: ReplayJobDoc): Promise<void> {
    const { db } = this.mongo;
    const owner = this.state.instanceId;
    const abort = new AbortController();
    this.abortCurrent = abort;

    log.info("replay started", { runId: job._id, attempt: job.attempt });
    this.state.replay = { runId: job._id, progress: 0 };

    let ranges: Range[] = [];
    let lastProgressAt = Date.now();
    let consumer: Consumer | undefined;

    const flush = new Loop("replay-progress", REPLAY.progressFlushMs, async () => {
      if (ranges.length === 0) return;
      const ok = await saveProgress(db, job._id, owner, toProgress(ranges));
      if (!ok) abort.abort(new PublicError("The replay lost its lease to another worker."));
      const total = ranges.reduce((sum, r) => sum + Number(r.end - r.start), 0);
      const done = ranges.reduce((sum, r) => sum + Number(r.position - r.start), 0);
      this.state.replay = { runId: job._id, progress: total > 0 ? Math.min(1, done / total) : 1 };
    });
    const lease = new Loop("replay-lease", REPLAY.leaseRenewMs, async () => {
      if (!(await renewLease(db, job._id, owner))) abort.abort(new PublicError("The replay lost its lease to another worker."));
      if (Date.now() - lastProgressAt > REPLAY.stallTimeoutMs) {
        abort.abort(new PublicError(`The replay made no progress for ${REPLAY.stallTimeoutMs / 1000} seconds.`));
      }
    });

    try {
      let partitions = job.partitions;
      if (partitions.length === 0) {
        partitions = await this.captureBoundaries(job._id);
      }
      ranges = toRanges(partitions);
      lease.start({ immediately: false });
      flush.start({ immediately: false });

      const pending = new Set(ranges.filter((r) => r.position < r.end).map((r) => r.partition));
      if (pending.size > 0) {
        consumer = this.kafka.consumer({
          groupId: job.groupId, // unique to this job: the live groups' offsets are never touched
          maxWaitTimeInMs: 1000,
          allowAutoTopicCreation: false,
        });
        // `consumer` is assigned before reading so the `finally` block can always disconnect it,
        // whether the read completes, fails, is interrupted, or loses its lease.
        await this.read(consumer, job, ranges, pending, abort, () => {
          lastProgressAt = Date.now();
        });
      }
      // An interruption or lost lease right at the end must not be reported as a completed run.
      if (abort.signal.aborted) throw abort.signal.reason;

      await flush.stop();
      await saveProgress(db, job._id, owner, toProgress(ranges.map((r) => ({ ...r, position: r.end }))));
      await completeJob(db, job._id, owner);
      log.info("replay completed", { runId: job._id });
    } catch (error) {
      await flush.stop();
      if (error instanceof Interrupted) {
        log.info("replay interrupted by shutdown; returning it to the queue", { runId: job._id });
        await releaseJob(db, job._id, owner, { interrupted: true });
      } else {
        log.error("replay attempt failed", { runId: job._id, error: errorMessage(error) });
        await releaseJob(db, job._id, owner, { error });
      }
    } finally {
      await lease.stop();
      await flush.stop();
      await this.cleanup(consumer, job.groupId);
      this.state.replay = null;
      this.abortCurrent = undefined;
    }
  }

  /** Captures every partition's end offset (and earliest retained offset) once per job. */
  private async captureBoundaries(runId: string): Promise<ReplayPartitionProgress[]> {
    const offsets = await this.admin.fetchTopicOffsets(TOPIC_NAME);
    const perPartitionCap = BigInt(Math.max(1, Math.floor(REPLAY.maxMessages / Math.max(1, offsets.length))));
    let truncated = false;
    const partitions = offsets
      .map((o) => {
        const low = BigInt(o.low);
        const high = BigInt(o.high);
        let start = low;
        if (high - low > perPartitionCap) {
          start = high - perPartitionCap;
          truncated = true;
        }
        return {
          partition: o.partition,
          startOffset: start.toString(),
          endOffset: high.toString(),
          position: start.toString(),
        };
      })
      .sort((a, b) => a.partition - b.partition);

    await saveBoundaries(this.mongo.db, runId, partitions, truncated);
    // Another attempt may have saved boundaries first; always use the persisted ones.
    const saved = await collections(this.mongo.db).replayJobs.findOne({ _id: runId });
    return saved && saved.partitions.length > 0 ? saved.partitions : partitions;
  }

  /** Consumes until every partition has reached its captured end offset. */
  private async read(
    consumer: Consumer,
    job: ReplayJobDoc,
    ranges: Range[],
    pending: Set<number>,
    abort: AbortController,
    onProgress: () => void,
  ): Promise<void> {
    const target: AnalyticsTarget = { kind: "replay", groupId: job.groupId, runId: job._id, expireAt: job.expireAt };
    const byPartition = new Map(ranges.map((r) => [r.partition, r]));

    // Created first: an abort during connect/subscribe/run (SIGTERM, lost lease, stall) must not
    // be missed, because a listener added to an already-aborted signal never fires.
    const interrupted = new Promise<never>((_, reject) => {
      if (abort.signal.aborted) return reject(abort.signal.reason);
      abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true });
    });
    interrupted.catch(() => undefined);

    let finished: () => void = () => undefined;
    const allDone = new Promise<void>((resolve) => (finished = resolve));
    const markDone = (partition: number) => {
      pending.delete(partition);
      if (pending.size === 0) finished();
    };

    const setup = (async () => {
      await consumer.connect();
      await consumer.subscribe({ topics: [TOPIC_NAME], fromBeginning: true });
      await consumer.run({
        autoCommit: false,
        eachBatchAutoResolve: false,
        partitionsConsumedConcurrently: 1,
        eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning }) => {
          const range = byPartition.get(batch.partition);
          if (!range || !pending.has(batch.partition)) {
            resolveOffset(batch.lastOffset());
            return;
          }
          for (const message of batch.messages) {
            if (!isRunning() || abort.signal.aborted) return;
            const offset = BigInt(message.offset);
            if (offset >= range.end) {
              markDone(batch.partition);
              break;
            }
            // Messages below `from` were already written by an earlier attempt (or are before the
            // truncation point): skip them without moving the saved position backwards.
            if (offset >= range.from) {
              await processAnalyticsMessage(
                this.mongo,
                target,
                { partition: batch.partition, offset: message.offset, value: message.value },
              );
              range.position = offset + 1n;
            }
            resolveOffset(message.offset);
            onProgress();
            if (range.position >= range.end) {
              markDone(batch.partition);
              break;
            }
            await heartbeat();
          }
        },
      });
    })();
    setup.catch(() => undefined); // a failure is observed through the race below

    await Promise.race([setup, interrupted]);
    await Promise.race([allDone, interrupted]);
  }

  /** Disconnects the temporary consumer and deletes its group so nothing lingers on the broker. */
  private async cleanup(consumer: Consumer | undefined, groupId: string): Promise<void> {
    if (consumer) {
      await consumer.stop().catch(() => undefined);
      await consumer.disconnect().catch(() => undefined);
    }
    await this.admin.deleteGroups([groupId]).catch((error) => {
      log.warn("could not delete replay group (it may not have been created)", { groupId, error: errorMessage(error) });
    });
  }
}
