import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { CONSUMER_KEYS, WORKER, type ConsumerKey } from "@/shared/constants";
import type { WorkerGroupDoc } from "@/lib/server/collections";

function emptyGroup(): WorkerGroupDoc {
  return { state: "starting", partitions: [], processed: 0, rejected: 0, lastProcessedAt: null, lastError: null };
}

/** In-memory status of this worker instance. The heartbeat loop copies it into MongoDB. */
export class WorkerState {
  readonly instanceId = randomUUID();
  readonly hostname = hostname();
  readonly startedAt = new Date();
  stopping = false;

  readonly groups = Object.fromEntries(CONSUMER_KEYS.map((key) => [key, emptyGroup()])) as Record<
    ConsumerKey,
    WorkerGroupDoc
  >;

  /** Desired pause state per group, refreshed from MongoDB by the command poller. */
  readonly desiredPaused = Object.fromEntries(CONSUMER_KEYS.map((key) => [key, false])) as Record<ConsumerKey, boolean>;

  private lastKafkaOkAt: number | null = null;

  replay: { runId: string; progress: number } | null = null;

  /** Call whenever a round trip to the brokers succeeds (group heartbeat, fetch, offset sample). */
  markKafkaOk(): void {
    this.lastKafkaOkAt = Date.now();
  }

  /**
   * Evidence-based, not socket-based: a frozen or unreachable broker can leave sockets open,
   * so "connected" means a request actually succeeded within the last few seconds.
   */
  get kafkaConnected(): boolean {
    return this.lastKafkaOkAt !== null && Date.now() - this.lastKafkaOkAt < WORKER.kafkaOkTtlMs;
  }
}
