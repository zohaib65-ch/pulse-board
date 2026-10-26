/**
 * Typed constants shared by the web app, the worker, and the tests.
 *
 * Everything that would otherwise be an environment variable lives here instead:
 * topic names, consumer group ids, polling intervals, thresholds, and batch limits.
 * This file must stay browser-safe (no Node-only imports).
 */

// ── Kafka topology ──────────────────────────────────────────────────────────
export const TOPIC_NAME = "website-events" as const;
/** The topic is created with exactly two partitions (see README). */
export const TOPIC_PARTITIONS = 2 as const;

export const CONSUMER_GROUP_IDS = {
  analytics: "pulseboard-analytics-v1",
  alerts: "pulseboard-alerts-v1",
} as const;

export type ConsumerKey = keyof typeof CONSUMER_GROUP_IDS;
export const CONSUMER_KEYS = Object.keys(CONSUMER_GROUP_IDS) as ConsumerKey[];

/** Each replay job uses its own temporary group: `${REPLAY_GROUP_PREFIX}${runId}`. */
export const REPLAY_GROUP_PREFIX = "pulseboard-replay-v1-" as const;

/** Value of `scope` on result documents that belong to the live (non-replay) pipeline. */
export const LIVE_SCOPE = "live" as const;

// ── Event contract ──────────────────────────────────────────────────────────
export const EVENT_TYPES = ["page_view", "product_click", "add_to_cart"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_SOURCES = ["playground", "simulator"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  page_view: "Page viewed",
  product_click: "Product clicked",
  add_to_cart: "Added to cart",
};

export const EVENT_LIMITS = {
  maxPageLength: 200,
  maxProductIdLength: 64,
  /** Events older than this are rejected at ingestion (Kafka retention is shorter anyway). */
  maxEventAgeMs: 24 * 60 * 60 * 1000,
  /** Small allowance for client clock skew. */
  maxFutureSkewMs: 5 * 60 * 1000,
} as const;

// ── Ingestion API ───────────────────────────────────────────────────────────
export const INGEST_LIMITS = {
  maxBatchSize: 10,
  maxBodyBytes: 16 * 1024,
} as const;

/** Browser-driven traffic generator limits (also enforced server-side per run id). */
export const SIMULATOR_LIMITS = {
  maxEventsPerRun: 100,
  maxEventsPerSecond: 10,
  /** The "spike" demo sends this many events from one session: one more than the alert threshold. */
  spikeBurstSize: 60,
} as const;

// ── Rate limits (MongoDB-backed fixed windows) ──────────────────────────────
export const RATE_LIMITS = {
  /** Wrong admin tokens tolerated per client per window before further attempts get 429. */
  authFailures: { limit: 10, windowMs: 5 * 60 * 1000 },
  /** All accepted ingestion traffic, any source. */
  ingestPerSecond: { limit: 20, windowMs: 1000 },
  ingestPerMinute: { limit: 300, windowMs: 60 * 1000 },
  /** Simulator traffic: at most 10 events per second across the whole app. */
  simulatorPerSecond: { limit: SIMULATOR_LIMITS.maxEventsPerSecond, windowMs: 1000 },
  /** Total events per simulator run id. */
  simulatorPerRun: { limit: SIMULATOR_LIMITS.maxEventsPerRun, windowMs: 60 * 60 * 1000 },
  /** Control actions: pause/resume, replay creation, token verification. */
  control: { limit: 20, windowMs: 60 * 1000 },
} as const;

// ── Dashboard queries ───────────────────────────────────────────────────────
export const RANGE_KEYS = ["15m", "1h", "24h"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];
export const DEFAULT_RANGE: RangeKey = "1h";

export const RANGES: Record<RangeKey, { label: string; minutes: number; chartBucketMinutes: number }> = {
  "15m": { label: "Last 15 minutes", minutes: 15, chartBucketMinutes: 1 },
  "1h": { label: "Last hour", minutes: 60, chartBucketMinutes: 2 },
  "24h": { label: "Last 24 hours", minutes: 24 * 60, chartBucketMinutes: 30 },
};

/** Storage granularity of time-bucketed metrics. Chart buckets are multiples of this. */
export const METRIC_BUCKET_MS = 60 * 1000;
export const ACTIVE_SESSION_WINDOW_MINUTES = 5;

export const QUERY_LIMITS = {
  eventsDefaultPageSize: 20,
  eventsMaxPageSize: 50,
  /** Event ids accepted by one `ids` lookup. */
  eventsLookupMaxIds: 20,
  productsDefaultPageSize: 10,
  productsMaxPageSize: 50,
  /** Distinct products read per aggregation, a hard bound on work per request. */
  productsMaxGroups: 500,
  topProducts: 5,
  alertsDefaultLimit: 10,
  alertsMaxLimit: 50,
  replayListLimit: 10,
  maxSearchLength: 64,
  /** Server-side time limit for every dashboard query. */
  maxTimeMs: 5000,
} as const;

// ── Browser polling ─────────────────────────────────────────────────────────
export const POLLING = {
  intervalMs: 5000,
  /** First retry delay after an error; doubles on each consecutive failure. */
  backoffBaseMs: 10_000,
  backoffMaxMs: 60_000,
  /** Data older than this is flagged as stale in the UI. */
  staleAfterMs: 20_000,
} as const;

// ── Alerts ──────────────────────────────────────────────────────────────────
/**
 * Spike rule: more than `eventsPerSessionPerWindow` events from one session inside one
 * tumbling one-minute window (by event timestamp) creates exactly one alert for that
 * session and window.
 */
export const SPIKE_RULE = {
  windowMs: 60 * 1000,
  eventsPerSessionPerWindow: 50,
} as const;

// ── Retention ───────────────────────────────────────────────────────────────
export const RETENTION = {
  /** Raw event history, time buckets, and session activity. */
  historyHours: 48,
  /** Deduplication records must outlive Kafka retention and any replay/redelivery window. */
  dedupeDays: 7,
  alertDays: 14,
  /** Spike counters live this long after their most recent event (processing time). */
  alertWindowMinutes: 60,
  rejectedDays: 7,
  /** Replay results and finished replay jobs. */
  replayResultHours: 24,
  workerDocHours: 1,
  rateLimitGraceSeconds: 60,
} as const;

// ── Worker ──────────────────────────────────────────────────────────────────
export const WORKER = {
  heartbeatIntervalMs: 5000,
  /** A worker without a heartbeat for this long is reported as stale. */
  staleAfterMs: 20_000,
  /** How often workers re-read the persisted pause/resume command per group. */
  commandPollMs: 2000,
  /** How often committed/latest offsets are sampled and written to MongoDB. */
  offsetSampleMs: 10_000,
  /** Offsets older than this are labelled stale in the UI. */
  offsetStaleAfterMs: 45_000,
  /** Kafka counts as connected only if a heartbeat, fetch, or offset sample succeeded this recently. */
  kafkaOkTtlMs: 15_000,
  shutdownTimeoutMs: 20_000,
  reconnectBackoff: { initialMs: 1000, maxMs: 30_000 },
  consumer: {
    sessionTimeoutMs: 30_000,
    heartbeatIntervalMs: 3000,
    maxWaitTimeInMs: 1000,
  },
} as const;

export const REPLAY = {
  leaseMs: 30_000,
  leaseRenewMs: 10_000,
  jobPollMs: 3000,
  maxAttempts: 3,
  /** Upper bound on messages read by one job; the oldest are skipped and the job is marked truncated. */
  maxMessages: 50_000,
  /** A job that makes no progress for this long is failed (and retried while attempts remain). */
  stallTimeoutMs: 30_000,
  progressFlushMs: 1000,
} as const;

// ── Transactions ────────────────────────────────────────────────────────────
export const TX = {
  maxCommitTimeMs: 10_000,
} as const;
