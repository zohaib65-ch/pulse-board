import { Kafka, type Consumer, type EachBatchPayload } from "kafkajs";
import { TOPIC_NAME, WORKER, type ConsumerKey } from "@/shared/constants";
import { errorMessage, publicErrorMessage } from "@/lib/server/errors";
import { log } from "@/lib/server/log";
import type { MongoEnv } from "@/lib/server/processing/shared";
import { consumeBatch, type BatchMessage } from "@/lib/server/processing/consume";
import type { ProcessOutcome } from "@/lib/server/processing/records";
import { backoffDelay, sleep } from "./util";
import type { WorkerState } from "./worker-state";

export interface GroupConsumerOptions {
  key: ConsumerKey;
  groupId: string;
  kafka: Kafka;
  mongo: MongoEnv;
  state: WorkerState;
  /** Applies one message to MongoDB; must be idempotent. */
  handle: (env: MongoEnv, record: BatchMessage) => Promise<ProcessOutcome>;
}

/**
 * One Kafka consumer group member, supervised.
 *
 * KafkaJS restarts the consumer by itself after retriable failures. For anything else
 * (non-retriable errors, failing to connect at all) this supervisor tears the consumer down
 * and creates a fresh one after an exponential backoff, so a broker or network outage never
 * kills the worker process.
 *
 * Pause/resume: the desired state lives in MongoDB (`state.desiredPaused`). Pausing keeps the
 * consumer in its group, heartbeating, so it does NOT trigger a rebalance and Kafka retains
 * the unread messages. The batch loop also checks the flag before every message, so pausing
 * takes effect immediately and survives KafkaJS restarting its internal consumer.
 */
export class GroupConsumer {
  private consumer: Consumer | undefined;
  private running = false;
  private readonly abort = new AbortController();
  private supervisor: Promise<void> = Promise.resolve();

  constructor(private readonly options: GroupConsumerOptions) {}

  private get group() {
    return this.options.state.groups[this.options.key];
  }

  start(): void {
    this.supervisor = this.supervise();
  }

  async stop(): Promise<void> {
    if (!this.abort.signal.aborted) this.abort.abort();
    const consumer = this.consumer;
    this.running = false;
    if (consumer) {
      await consumer.stop().catch(() => undefined);
      await consumer.disconnect().catch(() => undefined);
    }
    await this.supervisor;
    this.group.state = "stopped";
    this.group.partitions = [];
  }

  /** Applies `state.desiredPaused` to the running consumer. Safe to call at any time. */
  async reconcilePause(): Promise<void> {
    const { key, state } = this.options;
    const consumer = this.consumer;
    if (!consumer || !this.running) return;
    const paused = state.desiredPaused[key];
    try {
      if (paused) {
        consumer.pause([{ topic: TOPIC_NAME }]);
        if (this.group.state === "running" || this.group.state === "rebalancing") this.group.state = "paused";
      } else {
        consumer.resume([{ topic: TOPIC_NAME }]);
        if (this.group.state === "paused") this.group.state = "running";
      }
    } catch (error) {
      // pause/resume throw if the consumer is between restarts; the next reconcile retries.
      log.warn("pause/resume not applied yet", { group: key, error: errorMessage(error) });
    }
  }

  private async supervise(): Promise<void> {
    const { key } = this.options;
    let failures = 0;
    while (!this.abort.signal.aborted) {
      const startedAt = Date.now();
      try {
        await this.runUntilStopped();
      } catch (error) {
        this.group.state = "error";
        this.group.lastError = publicErrorMessage(error); // shown by the public status endpoint
        log.error("consumer failed", { group: key, error: errorMessage(error) });
      }
      if (this.abort.signal.aborted) break;
      // A consumer that ran for a while counts as healthy again.
      failures = Date.now() - startedAt > 60_000 ? 0 : failures + 1;
      const delay = backoffDelay(failures, WORKER.reconnectBackoff.initialMs, WORKER.reconnectBackoff.maxMs);
      log.warn("restarting consumer", { group: key, inMs: delay });
      await sleep(delay, this.abort.signal);
    }
  }

  /** Runs one consumer incarnation. Resolves when KafkaJS gives up (non-retriable crash). */
  private async runUntilStopped(): Promise<void> {
    const { key, groupId, kafka, mongo, state, handle } = this.options;
    const consumer = kafka.consumer({
      groupId,
      sessionTimeout: WORKER.consumer.sessionTimeoutMs,
      heartbeatInterval: WORKER.consumer.heartbeatIntervalMs,
      maxWaitTimeInMs: WORKER.consumer.maxWaitTimeInMs,
      allowAutoTopicCreation: false,
    });
    this.consumer = consumer;
    this.group.state = "starting";

    const { HEARTBEAT, FETCH, GROUP_JOIN, REBALANCING, CRASH, STOP } = consumer.events;
    let crashed: ((error: Error) => void) | undefined;
    const gaveUp = new Promise<Error>((resolve) => (crashed = resolve));

    consumer.on(HEARTBEAT, () => state.markKafkaOk());
    consumer.on(FETCH, () => state.markKafkaOk());
    consumer.on(REBALANCING, () => {
      this.group.state = "rebalancing";
    });
    consumer.on(GROUP_JOIN, (event) => {
      this.group.partitions = [...(event.payload.memberAssignment[TOPIC_NAME] ?? [])].sort((a, b) => a - b);
      this.group.state = state.desiredPaused[key] ? "paused" : "running";
      this.group.lastError = null;
      log.info("joined group", { group: key, partitions: this.group.partitions });
      void this.reconcilePause();
    });
    consumer.on(CRASH, (event) => {
      this.group.state = "error";
      this.group.lastError = publicErrorMessage(event.payload.error);
      log.error("consumer crashed", { group: key, error: errorMessage(event.payload.error), restart: event.payload.restart });
      // KafkaJS restarts retriable failures itself; only a final crash needs the supervisor.
      if (!event.payload.restart) crashed?.(event.payload.error);
    });
    consumer.on(STOP, () => {
      this.group.partitions = [];
    });

    // Created before connecting, so a stop() that arrives while connecting, subscribing, or
    // joining the group is not missed (a listener added after an abort would never fire).
    const stopped = new Promise<void>((resolve) => {
      if (this.abort.signal.aborted) return resolve();
      this.abort.signal.addEventListener("abort", () => resolve(), { once: true });
    });

    try {
      const setup = (async () => {
        await consumer.connect();
        await consumer.subscribe({ topics: [TOPIC_NAME], fromBeginning: true });
        this.running = true;
        await consumer.run({
          // Offsets are resolved and committed explicitly, only after MongoDB has the result.
          autoCommit: false,
          eachBatchAutoResolve: false,
          partitionsConsumedConcurrently: 1,
          eachBatch: (payload) => this.onBatch(consumer, mongo, handle, payload),
        });
        await this.reconcilePause();
      })();
      setup.catch(() => undefined); // a failure is observed through the race below

      const ready = await Promise.race([setup.then(() => true), stopped.then(() => false)]);
      if (!ready) return;
      const outcome = await Promise.race([gaveUp, stopped]);
      if (outcome instanceof Error) throw outcome;
    } finally {
      // Whatever happened (stop, crash, failed connect/subscribe/run), this consumer is released.
      this.running = false;
      await consumer.disconnect().catch(() => undefined);
      if (this.consumer === consumer) this.consumer = undefined;
    }
  }

  private async onBatch(
    consumer: Consumer,
    mongo: MongoEnv,
    handle: GroupConsumerOptions["handle"],
    { batch, resolveOffset, heartbeat, isRunning, pause }: EachBatchPayload,
  ): Promise<void> {
    const { key, state } = this.options;
    const messages: BatchMessage[] = batch.messages.map((message) => ({
      partition: batch.partition,
      offset: message.offset,
      value: message.value,
    }));

    const result = await consumeBatch({
      messages,
      isPaused: () => state.desiredPaused[key],
      isRunning: () => isRunning() && !state.stopping,
      handle: (record) => handle(mongo, record),
      resolveOffset,
      commit: (nextOffset) =>
        consumer.commitOffsets([{ topic: batch.topic, partition: batch.partition, offset: nextOffset }]),
      heartbeat,
      onOutcome: (outcome) => {
        if (outcome.status === "rejected") this.group.rejected++;
        else this.group.processed++;
        this.group.lastProcessedAt = new Date();
      },
    });

    if (result.stopReason === "paused") {
      // Stop fetching this partition right away instead of re-entering this loop; the unresolved
      // messages stay in Kafka and are re-fetched from the first unresolved offset after resume.
      pause();
      if (this.group.state !== "error") this.group.state = "paused";
    }
  }
}
