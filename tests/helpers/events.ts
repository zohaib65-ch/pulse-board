import { randomUUID } from "node:crypto";
import type { WebsiteEvent } from "@/shared/event-schema";
import type { BatchMessage } from "@/lib/server/processing/consume";

export function makeEvent(overrides: Partial<WebsiteEvent> = {}): WebsiteEvent {
  return {
    eventId: randomUUID(),
    type: "page_view",
    timestamp: new Date().toISOString(),
    sessionId: randomUUID(),
    page: "/",
    source: "playground",
    ...overrides,
  };
}

/** Wraps events as Kafka messages on one partition with sequential offsets. */
export function toMessages(events: unknown[], options: { partition?: number; startOffset?: number } = {}): BatchMessage[] {
  const { partition = 0, startOffset = 0 } = options;
  return events.map((event, index) => ({
    partition,
    offset: String(startOffset + index),
    value: Buffer.from(typeof event === "string" ? event : JSON.stringify(event)),
  }));
}
