import type { Collection, Db } from "mongodb";
import type { ConsumerKey, EventSource, EventType } from "@/shared/constants";
import type { ConsumerState, ReplayPartitionProgress, ReplayStatus } from "@/shared/api";

/**
 * MongoDB collections, document shapes, and indexes.
 *
 * Result documents carry a `scope`: "live" for the live pipeline, or a replay run id.
 * Replays write under their own scope with their own deduplication, so they can never
 * touch live numbers. Every collection that grows has a TTL index on `expireAt`.
 */
export const COLLECTION_NAMES = {
  events: "events",
  metricBuckets: "metric_buckets",
  productBuckets: "product_buckets",
  sessions: "session_activity",
  dedupe: "processed_messages",
  rejected: "rejected_messages",
  alerts: "alerts",
  alertWindows: "alert_session_windows",
  workers: "worker_instances",
  offsets: "consumer_offsets",
  commands: "consumer_commands",
  replayJobs: "replay_jobs",
  rateLimits: "rate_limits",
  serviceState: "service_state",
} as const;

export interface EventDoc {
  /** eventId */
  _id: string;
  type: EventType;
  timestamp: Date;
  sessionId: string;
  page: string;
  productId?: string;
  source: EventSource;
  partition: number;
  offset: string;
  processedAt: Date;
  expireAt: Date;
}

export interface MetricBucketDoc {
  /** `${scope}|${bucketStartMs}` */
  _id: string;
  scope: string;
  bucket: Date;
  page_view?: number;
  product_click?: number;
  add_to_cart?: number;
  expireAt: Date;
}

export interface ProductBucketDoc {
  /** `${scope}|${bucketStartMs}|${productId}` */
  _id: string;
  scope: string;
  bucket: Date;
  productId: string;
  clicks?: number;
  cartAdds?: number;
  expireAt: Date;
}

export interface SessionDoc {
  /** `${scope}|${sessionId}` */
  _id: string;
  scope: string;
  sessionId: string;
  firstSeen: Date;
  lastSeen: Date;
  expireAt: Date;
}

export interface DedupeDoc {
  /** `${groupId}|${eventId}` or `${groupId}|rejected|${partition}|${offset}` */
  _id: string;
  groupId: string;
  kind: "event" | "rejected";
  partition: number;
  offset: string;
  processedAt: Date;
  expireAt: Date;
}

export interface RejectedDoc {
  _id: string;
  groupId: string;
  partition: number;
  offset: string;
  reason: string;
  preview: string;
  at: Date;
  expireAt: Date;
}

export interface AlertDoc {
  /** `spike|${sessionId}|${windowStartMs}`: one alert per session and window. */
  _id: string;
  kind: "session_spike";
  sessionId: string;
  count: number;
  threshold: number;
  windowStart: Date;
  windowEnd: Date;
  createdAt: Date;
  triggerEventId: string;
  expireAt: Date;
}

export interface AlertWindowDoc {
  /** `${sessionId}|${windowStartMs}` */
  _id: string;
  sessionId: string;
  windowStart: Date;
  count: number;
  expireAt: Date;
}

export interface WorkerGroupDoc {
  state: ConsumerState;
  partitions: number[];
  processed: number;
  rejected: number;
  lastProcessedAt: Date | null;
  lastError: string | null;
}

export interface WorkerDoc {
  /** instanceId */
  _id: string;
  hostname: string;
  startedAt: Date;
  lastHeartbeatAt: Date;
  kafkaConnected: boolean;
  groups: Record<ConsumerKey, WorkerGroupDoc>;
  replay: { runId: string; progress: number } | null;
  expireAt: Date;
}

export interface OffsetsDoc {
  /** consumer key */
  _id: ConsumerKey;
  groupId: string;
  sampledAt: Date;
  sampledBy: string;
  partitions: { partition: number; committed: string | null; earliest: string; latest: string }[];
}

export interface CommandDoc {
  /** consumer key */
  _id: ConsumerKey;
  paused: boolean;
  pausedAt: Date | null;
  updatedAt: Date;
}

export interface ReplayJobDoc {
  /** runId */
  _id: string;
  status: ReplayStatus;
  groupId: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Present (true) only while queued or running; a unique partial index allows at most one active job. */
  active?: true;
  attempt: number;
  lease: { owner: string; expiresAt: Date } | null;
  partitions: ReplayPartitionProgress[];
  processed: number;
  rejected: number;
  truncated: boolean;
  /** Omitted until the first event: `$min` would never replace an explicit null. */
  firstEventAt?: Date;
  lastEventAt?: Date;
  error: string | null;
  expireAt: Date;
}

export interface RateLimitDoc {
  _id: string;
  count: number;
  expireAt: Date;
}

export interface ServiceStateDoc {
  _id: "ingest";
  lastPublishAt?: Date;
  lastError?: { at: Date; message: string };
}

export interface Collections {
  events: Collection<EventDoc>;
  metricBuckets: Collection<MetricBucketDoc>;
  productBuckets: Collection<ProductBucketDoc>;
  sessions: Collection<SessionDoc>;
  dedupe: Collection<DedupeDoc>;
  rejected: Collection<RejectedDoc>;
  alerts: Collection<AlertDoc>;
  alertWindows: Collection<AlertWindowDoc>;
  workers: Collection<WorkerDoc>;
  offsets: Collection<OffsetsDoc>;
  commands: Collection<CommandDoc>;
  replayJobs: Collection<ReplayJobDoc>;
  rateLimits: Collection<RateLimitDoc>;
  serviceState: Collection<ServiceStateDoc>;
}

export function collections(db: Db): Collections {
  const n = COLLECTION_NAMES;
  return {
    events: db.collection<EventDoc>(n.events),
    metricBuckets: db.collection<MetricBucketDoc>(n.metricBuckets),
    productBuckets: db.collection<ProductBucketDoc>(n.productBuckets),
    sessions: db.collection<SessionDoc>(n.sessions),
    dedupe: db.collection<DedupeDoc>(n.dedupe),
    rejected: db.collection<RejectedDoc>(n.rejected),
    alerts: db.collection<AlertDoc>(n.alerts),
    alertWindows: db.collection<AlertWindowDoc>(n.alertWindows),
    workers: db.collection<WorkerDoc>(n.workers),
    offsets: db.collection<OffsetsDoc>(n.offsets),
    commands: db.collection<CommandDoc>(n.commands),
    replayJobs: db.collection<ReplayJobDoc>(n.replayJobs),
    rateLimits: db.collection<RateLimitDoc>(n.rateLimits),
    serviceState: db.collection<ServiceStateDoc>(n.serviceState),
  };
}

const TTL = { key: { expireAt: 1 }, expireAfterSeconds: 0 } as const;

/** Idempotent. Safe to run from the web app and every worker instance. */
export async function createIndexes(db: Db): Promise<void> {
  const c = collections(db);
  await Promise.all([
    c.events.createIndexes([
      { key: { timestamp: -1, _id: -1 } },
      { key: { type: 1, timestamp: -1, _id: -1 } },
      { key: { page: 1, timestamp: -1, _id: -1 } },
      { key: { productId: 1, timestamp: -1, _id: -1 } },
      TTL,
    ]),
    c.metricBuckets.createIndexes([{ key: { scope: 1, bucket: 1 } }, TTL]),
    c.productBuckets.createIndexes([{ key: { scope: 1, bucket: 1 } }, TTL]),
    c.sessions.createIndexes([{ key: { scope: 1, lastSeen: -1 } }, TTL]),
    c.dedupe.createIndexes([TTL]),
    c.rejected.createIndexes([{ key: { at: -1 } }, TTL]),
    c.alerts.createIndexes([{ key: { createdAt: -1 } }, TTL]),
    c.alertWindows.createIndexes([TTL]),
    c.workers.createIndexes([{ key: { lastHeartbeatAt: -1 } }, TTL]),
    c.replayJobs.createIndexes([
      { key: { createdAt: -1 } },
      { key: { status: 1, "lease.expiresAt": 1 } },
      { key: { active: 1 }, unique: true, partialFilterExpression: { active: true } },
      TTL,
    ]),
    c.rateLimits.createIndexes([TTL]),
  ]);
}

const indexed = new WeakSet<Db>();

/** Creates indexes at most once per Db handle; failures are retried on the next call. */
export async function ensureIndexes(db: Db): Promise<void> {
  if (indexed.has(db)) return;
  await createIndexes(db);
  indexed.add(db);
}
