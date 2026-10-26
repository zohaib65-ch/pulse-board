/**
 * HTTP contract between the Route Handlers and the browser.
 *
 * Every response is an envelope: `{ ok: true, data }` or `{ ok: false, error }`.
 * Timestamps are ISO 8601 strings in UTC. Kafka offsets are strings (they are 64-bit).
 */
import { z } from "zod";
import type { ConsumerKey, EventSource, EventType, RangeKey } from "./constants";
import { CONSUMER_KEYS } from "./constants";

// ── Envelope ────────────────────────────────────────────────────────────────
export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "rate_limited"
  | "payload_too_large"
  | "not_found"
  | "conflict"
  | "kafka_unavailable"
  | "database_unavailable"
  | "server_misconfigured"
  | "internal_error";

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  /** Field-level problems for `invalid_request`. */
  issues?: { path: string; message: string }[];
  retryAfterSeconds?: number;
}

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: ApiErrorBody };

// ── Ingestion ───────────────────────────────────────────────────────────────
/** 202 body: Kafka has acknowledged the events. They are accepted, not yet processed. */
export interface IngestData {
  accepted: number;
  eventIds: string[];
  /** One entry per partition written by this request. */
  acks: { partition: number; baseOffset: string }[];
  acceptedAt: string;
}

// ── Overview ────────────────────────────────────────────────────────────────
export interface SeriesPoint {
  /** Bucket start. */
  t: string;
  page_view: number;
  product_click: number;
  add_to_cart: number;
}

export interface BreakdownRow {
  type: EventType;
  count: number;
  /** count ÷ all events in range; null when the range has no events. */
  share: number | null;
}

export interface ProductRow {
  productId: string;
  name: string;
  clicks: number;
  cartAdds: number;
  /** cartAdds ÷ clicks for this product; null when clicks is 0. May exceed 1 (cart adds are not tied to a specific click). */
  cartAddRatio: number | null;
  /** clicks ÷ all product clicks in range; null when there are no clicks. */
  clickShare: number | null;
}

export interface Totals {
  pageViews: number;
  productClicks: number;
  cartAdditions: number;
  events: number;
}

export interface OverviewData {
  range: RangeKey;
  from: string;
  to: string;
  generatedAt: string;
  bucketMinutes: number;
  totals: Totals;
  /** Distinct sessions seen in the last `windowMinutes`, independent of the range filter. */
  activeSessions: { count: number; windowMinutes: number };
  series: SeriesPoint[];
  breakdown: BreakdownRow[];
  topProducts: ProductRow[];
}

// ── Products ────────────────────────────────────────────────────────────────
export const PRODUCT_SORT_KEYS = ["name", "clicks", "cartAdds", "cartAddRatio", "clickShare"] as const;
export type ProductSortKey = (typeof PRODUCT_SORT_KEYS)[number];

export interface ProductsData {
  range: RangeKey;
  from: string;
  to: string;
  generatedAt: string;
  items: ProductRow[];
  /** Totals across ALL matching products, not just this page. */
  totals: { clicks: number; cartAdds: number };
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  sort: ProductSortKey;
  order: "asc" | "desc";
  q: string;
}

// ── Events ──────────────────────────────────────────────────────────────────
export interface EventItem {
  eventId: string;
  type: EventType;
  timestamp: string;
  sessionId: string;
  page: string;
  productId: string | null;
  source: EventSource;
  kafka: { partition: number; offset: string };
  /** When the analytics consumer stored the event. */
  processedAt: string;
}

export interface EventsData {
  range: RangeKey;
  generatedAt: string;
  items: EventItem[];
  /** Opaque cursor for the next (older) page; null on the last page. */
  nextCursor: string | null;
  limit: number;
}

// ── Alerts ──────────────────────────────────────────────────────────────────
export interface AlertItem {
  id: string;
  kind: "session_spike";
  sessionId: string;
  /** Events seen from the session in the window when the alert fired. */
  count: number;
  threshold: number;
  windowStart: string;
  windowEnd: string;
  createdAt: string;
}

export interface AlertsData {
  generatedAt: string;
  items: AlertItem[];
}

// ── Status ──────────────────────────────────────────────────────────────────
export type ConsumerState = "starting" | "running" | "paused" | "rebalancing" | "error" | "stopped";

export interface WorkerGroupStatus {
  state: ConsumerState;
  /** Partitions currently assigned to this instance for this group. */
  partitions: number[];
  processed: number;
  rejected: number;
  lastProcessedAt: string | null;
  lastError: string | null;
}

export interface WorkerStatus {
  instanceId: string;
  startedAt: string;
  lastHeartbeatAt: string;
  /** True when the last heartbeat is older than the stale threshold. */
  stale: boolean;
  kafkaConnected: boolean;
  groups: Record<ConsumerKey, WorkerGroupStatus>;
  replay: { runId: string; progress: number } | null;
}

export interface PartitionOffsets {
  partition: number;
  /** Next offset the group will read; null if the group has never committed. */
  committed: string | null;
  /** Log end offset (next offset to be written). */
  latest: string;
  /** Approximate messages not yet processed. */
  lag: number;
}

export interface GroupOffsets {
  sampledAt: string;
  /** True when the sample is older than the stale threshold, so the numbers may be out of date. */
  stale: boolean;
  partitions: PartitionOffsets[];
  totalLag: number;
}

export interface GroupStatus {
  key: ConsumerKey;
  groupId: string;
  /** Persisted desired state; every worker instance applies it. */
  paused: boolean;
  pausedAt: string | null;
  /** What live workers actually report, derived from fresh heartbeats. */
  effective: "running" | "paused" | "mixed" | "no_workers";
  offsets: GroupOffsets | null;
}

export interface StatusData {
  generatedAt: string;
  database: { ok: true };
  kafka: {
    topic: string;
    partitions: number;
    lastPublishAt: string | null;
    lastPublishError: { at: string; message: string } | null;
    /** True if at least one fresh worker heartbeat reports a Kafka connection. */
    workerConnected: boolean | null;
  };
  workers: WorkerStatus[];
  groups: GroupStatus[];
  /** Newest event stored by the analytics consumer, or null if none retained. */
  lastEventAt: string | null;
  retention: { historyHours: number };
}

// ── Control ─────────────────────────────────────────────────────────────────
export const consumerActionSchema = z.strictObject({
  action: z.enum(["pause", "resume"]),
});
export type ConsumerAction = z.infer<typeof consumerActionSchema>["action"];

export const consumerKeySchema = z.enum(CONSUMER_KEYS as [ConsumerKey, ...ConsumerKey[]]);

export interface ConsumerControlData {
  key: ConsumerKey;
  paused: boolean;
  updatedAt: string;
}

export interface AdminVerifyData {
  verified: true;
}

// ── Replay ──────────────────────────────────────────────────────────────────
export type ReplayStatus = "queued" | "running" | "completed" | "failed";

export interface ReplayPartitionProgress {
  partition: number;
  startOffset: string;
  endOffset: string;
  /** Next offset to read; equals endOffset when the partition is done. */
  position: string;
}

export interface ReplayJobData {
  id: string;
  status: ReplayStatus;
  groupId: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  attempt: number;
  /** 0–1 by offsets; 1 when finished. */
  progress: number;
  partitions: ReplayPartitionProgress[];
  /** Events written to this run's results (excludes duplicates). */
  processed: number;
  rejected: number;
  /** True when more messages were retained than the per-job cap, so the oldest were skipped. */
  truncated: boolean;
  error: string | null;
  /** When the isolated result set is deleted. */
  expiresAt: string;
}

export interface ReplayResultData {
  totals: Totals;
  sessions: number;
  bucketMinutes: number;
  series: SeriesPoint[];
  breakdown: BreakdownRow[];
  topProducts: ProductRow[];
  firstEventAt: string | null;
  lastEventAt: string | null;
  /** Live totals for the same window, read from the live result set. Replays never change these. */
  liveTotalsForWindow: Totals | null;
}

export interface ReplayDetailData {
  job: ReplayJobData;
  /** Null until the job has produced results. */
  result: ReplayResultData | null;
}

export interface ReplayListData {
  generatedAt: string;
  items: ReplayJobData[];
}
