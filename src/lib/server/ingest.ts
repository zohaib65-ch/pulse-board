import type { Db } from "mongodb";
import { RATE_LIMITS } from "@/shared/constants";
import type { IngestData } from "@/shared/api";
import { checkTimestampWindow, type IngestRequest } from "@/shared/event-schema";
import { collections } from "./collections";
import { ApiError, errorMessage } from "./errors";
import { log } from "./log";
import { publishEvents, PublishError } from "./kafka";
import { enforce } from "./rate-limit";

/** Semantic checks that the schema cannot express. Throws a 400 ApiError. */
export function validateBatch(body: IngestRequest, nowMs: number = Date.now()): void {
  const issues: { path: string; message: string }[] = [];
  const seen = new Set<string>();
  const sources = new Set(body.events.map((event) => event.source));

  body.events.forEach((event, index) => {
    const problem = checkTimestampWindow(event.timestamp, nowMs);
    if (problem) issues.push({ path: `events.${index}.timestamp`, message: problem });
    if (seen.has(event.eventId)) issues.push({ path: `events.${index}.eventId`, message: "duplicate eventId in batch" });
    seen.add(event.eventId);
  });
  if (sources.size > 1) issues.push({ path: "events", message: "all events in one request must share the same source" });
  if (sources.has("simulator") && !body.runId) issues.push({ path: "runId", message: "runId is required for simulator events" });

  if (issues.length > 0) {
    throw new ApiError(400, "invalid_request", "Invalid request body.", { issues });
  }
}

/**
 * Accepts a validated batch: applies MongoDB-backed rate limits, publishes to Kafka,
 * and only after Kafka acknowledges the write reports the events as accepted.
 * Accepted means durably in Kafka, NOT yet processed by any consumer.
 */
export async function acceptEvents(db: Db, body: IngestRequest): Promise<IngestData> {
  validateBatch(body);
  const cost = body.events.length;

  await enforce(db, "ingest:second", RATE_LIMITS.ingestPerSecond, cost, "Ingestion rate limit exceeded.");
  await enforce(db, "ingest:minute", RATE_LIMITS.ingestPerMinute, cost, "Ingestion rate limit exceeded.");
  if (body.events[0].source === "simulator") {
    await enforce(db, "simulator:second", RATE_LIMITS.simulatorPerSecond, cost, "The traffic generator is limited to 10 events per second.");
    await enforce(db, `simulator-run:${body.runId}`, RATE_LIMITS.simulatorPerRun, cost, "A generator run is limited to 100 events.");
  }

  const state = collections(db).serviceState;
  try {
    const acks = await publishEvents(body.events);
    const acceptedAt = new Date();
    await state
      .updateOne({ _id: "ingest" }, { $set: { lastPublishAt: acceptedAt }, $unset: { lastError: "" } }, { upsert: true })
      .catch((error) => log.warn("could not record publish state", { error: errorMessage(error) }));
    return {
      accepted: cost,
      eventIds: body.events.map((event) => event.eventId),
      acks,
      acceptedAt: acceptedAt.toISOString(),
    };
  } catch (error) {
    if (!(error instanceof PublishError)) throw error;
    log.error("kafka publish failed", { error: error.message });
    await state
      .updateOne({ _id: "ingest" }, { $set: { lastError: { at: new Date(), message: error.publicMessage } } }, { upsert: true })
      .catch(() => undefined);
    throw new ApiError(
      503,
      "kafka_unavailable",
      "Kafka did not acknowledge the events, so they are not reported as accepted (a multi-partition write may have partly landed). Retry with the same eventIds; consumers ignore duplicates.",
    );
  }
}
