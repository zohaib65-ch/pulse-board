import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { INGEST_LIMITS } from "@/shared/constants";
import { checkTimestampWindow, eventSchema, ingestRequestSchema } from "@/shared/event-schema";
import { validateBatch } from "@/lib/server/ingest";
import { makeEvent } from "./helpers/events";

const valid = () => makeEvent();

describe("event schema: invalid events are rejected", () => {
  it("accepts a well-formed event", () => {
    expect(eventSchema.safeParse(valid()).success).toBe(true);
  });

  it.each([
    ["non-uuid eventId", { eventId: "not-a-uuid" }],
    ["non-uuid sessionId", { sessionId: "session-1" }],
    ["unknown type", { type: "purchase" }],
    ["unknown source", { source: "browser" }],
    ["timestamp that is not ISO", { timestamp: "yesterday" }],
    ["timestamp without time zone", { timestamp: "2026-01-01T10:00:00" }],
    ["calendar-invalid timestamp", { timestamp: "2026-02-31T10:00:00Z" }],
    ["page without leading slash", { page: "products" }],
    ["page with a query string", { page: "/products?email=a@b.c" }],
    ["page with a fragment", { page: "/products#top" }],
    ["page with whitespace", { page: "/my page" }],
    ["page over 200 characters", { page: `/${"a".repeat(200)}` }],
    ["productId with uppercase", { productId: "Aurora Lamp" }],
    ["productId over 64 characters", { productId: "a".repeat(65) }],
  ])("rejects %s", (_name, patch) => {
    expect(eventSchema.safeParse({ ...valid(), ...patch }).success).toBe(false);
  });

  it.each(["product_click", "add_to_cart"] as const)("requires productId for %s", (type) => {
    const result = eventSchema.safeParse({ ...valid(), type });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["productId"]);
    expect(eventSchema.safeParse({ ...valid(), type, productId: "cedar-notebook" }).success).toBe(true);
  });

  it("does not require productId for page views", () => {
    expect(eventSchema.safeParse({ ...valid(), type: "page_view" }).success).toBe(true);
  });

  it("rejects unknown fields instead of silently storing them", () => {
    expect(eventSchema.safeParse({ ...valid(), email: "a@b.c" }).success).toBe(false);
  });

  it("bounds the batch size", () => {
    const events = Array.from({ length: INGEST_LIMITS.maxBatchSize + 1 }, valid);
    expect(ingestRequestSchema.safeParse({ events }).success).toBe(false);
    expect(ingestRequestSchema.safeParse({ events: [] }).success).toBe(false);
    expect(ingestRequestSchema.safeParse({ events: events.slice(0, INGEST_LIMITS.maxBatchSize) }).success).toBe(true);
  });
});

describe("server-side batch checks", () => {
  const now = Date.parse("2026-06-01T12:00:00Z");

  it("rejects timestamps older than 24 hours or in the future", () => {
    expect(checkTimestampWindow("2026-05-31T11:59:00Z", now)).toMatch(/older/);
    expect(checkTimestampWindow("2026-06-01T12:06:00Z", now)).toMatch(/future/);
    expect(checkTimestampWindow("2026-06-01T11:00:00Z", now)).toBeNull();
    expect(checkTimestampWindow("2026-06-01T12:04:00Z", now)).toBeNull();
  });

  it("rejects duplicate eventIds inside one batch", () => {
    const event = makeEvent({ timestamp: new Date(now).toISOString() });
    expect(() => validateBatch({ events: [event, event] }, now)).toThrow(/Invalid request body/);
  });

  it("requires a runId for simulator events and forbids mixing sources", () => {
    const sim = makeEvent({ source: "simulator", timestamp: new Date(now).toISOString() });
    const manual = makeEvent({ timestamp: new Date(now).toISOString() });
    expect(() => validateBatch({ events: [sim] }, now)).toThrow();
    expect(() => validateBatch({ events: [sim], runId: randomUUID() }, now)).not.toThrow();
    expect(() => validateBatch({ events: [sim, manual], runId: randomUUID() }, now)).toThrow();
  });
});
