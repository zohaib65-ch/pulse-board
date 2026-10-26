import { EVENT_LIMITS } from "@/shared/constants";
import { eventSchema, type WebsiteEvent } from "@/shared/event-schema";

/** The slice of a Kafka message the processors need. */
export interface MessageRecord {
  partition: number;
  /** Kafka offsets are 64-bit; KafkaJS hands them over as strings. */
  offset: string;
  value: Buffer | string | null;
}

export type ParsedRecord =
  | { ok: true; event: WebsiteEvent }
  | { ok: false; reason: string; preview: string };

const MAX_MESSAGE_BYTES = 64 * 1024;
const PREVIEW_LENGTH = 200;

function preview(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, PREVIEW_LENGTH);
}

/**
 * Turns a raw Kafka message into a validated event, or explains why it cannot be one.
 * A malformed message must never throw: callers record it as rejected and move on,
 * so one bad message cannot block a partition.
 */
export function parseRecord(record: MessageRecord, nowMs: number = Date.now()): ParsedRecord {
  if (record.value === null) return { ok: false, reason: "empty message", preview: "" };
  const text = typeof record.value === "string" ? record.value : record.value.toString("utf8");
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) {
    return { ok: false, reason: "message larger than 64 KiB", preview: preview(text) };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not valid JSON", preview: preview(text) };
  }

  const result = eventSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, reason: `invalid event: ${issues}`, preview: preview(text) };
  }

  // A far-future timestamp would create buckets that never expire; treat it as poison.
  if (Date.parse(result.data.timestamp) > nowMs + EVENT_LIMITS.maxEventAgeMs) {
    return { ok: false, reason: "timestamp more than 24 hours in the future", preview: preview(text) };
  }
  return { ok: true, event: result.data };
}

export type ProcessOutcome =
  | { status: "applied"; eventId: string; alertCreated?: boolean }
  | { status: "duplicate"; eventId: string }
  | { status: "rejected"; reason: string };
