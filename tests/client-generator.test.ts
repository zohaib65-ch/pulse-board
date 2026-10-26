import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { IngestData } from "@/shared/api";
import { SIMULATOR_LIMITS, SPIKE_RULE } from "@/shared/constants";
import { eventSchema, type IngestRequest } from "@/shared/event-schema";
import { ApiError } from "@/lib/client/api";
import { newId } from "@/lib/client/ids";
import {
  generatorFormSchema,
  planRun,
  buildEvent,
  sendIntervalMs,
  retryDelayMs,
  TrafficGenerator,
  MAX_RETRIES,
} from "@/lib/client/traffic-generator";

const ack = (accepted = 1): IngestData => ({
  accepted,
  eventIds: [],
  acks: [{ partition: 1, baseOffset: "7" }],
  acceptedAt: new Date().toISOString(),
});
const apiError = (status: number, code: ConstructorParameters<typeof ApiError>[0]["code"], retryAfterSeconds?: number) =>
  new ApiError({ status, code, message: `${code} happened`, retryAfterSeconds });

describe("traffic generator form limits", () => {
  const ok = { mode: "random", events: 100, ratePerSecond: 10 } as const;

  it("accepts the documented maximums and rejects anything above them", () => {
    expect(generatorFormSchema.safeParse(ok).success).toBe(true);
    expect(generatorFormSchema.safeParse({ ...ok, events: SIMULATOR_LIMITS.maxEventsPerRun + 1 }).success).toBe(false);
    expect(generatorFormSchema.safeParse({ ...ok, ratePerSecond: SIMULATOR_LIMITS.maxEventsPerSecond + 1 }).success).toBe(false);
    expect(generatorFormSchema.safeParse({ ...ok, events: 0 }).success).toBe(false);
    expect(generatorFormSchema.safeParse({ ...ok, ratePerSecond: 2.5 }).success).toBe(false);
  });

  it("validates the events field only for random traffic; a spike ignores it", () => {
    const spike = { mode: "spike", ratePerSecond: 5 } as const;
    expect(generatorFormSchema.safeParse({ ...spike, events: 500 }).success).toBe(true);
    expect(generatorFormSchema.safeParse({ ...spike, events: Number.NaN }).success).toBe(true);
    expect(generatorFormSchema.safeParse({ ...spike, events: 0 }).success).toBe(true);
    // The rate still applies to a spike.
    expect(generatorFormSchema.safeParse({ ...spike, events: 500, ratePerSecond: 11 }).success).toBe(false);
    expect(generatorFormSchema.safeParse({ ...spike, events: 500, ratePerSecond: 1 }).success).toBe(false);
    // Random traffic still shows a visible, field-level error for a cleared or oversized field.
    for (const events of [Number.NaN, 101, 0, 2.5]) {
      const result = generatorFormSchema.safeParse({ mode: "random", ratePerSecond: 5, events });
      expect(result.success).toBe(false);
      expect(!result.success && result.error.issues.map((issue) => issue.path.join("."))).toContain("events");
    }
  });

  it("never paces faster than 10 events per second", () => {
    expect(sendIntervalMs(10)).toBe(100);
    expect(sendIntervalMs(1000)).toBe(100); // clamped even if a caller passes a larger rate
    expect(sendIntervalMs(5)).toBe(200);
  });
});

describe("planning", () => {
  const now = Date.parse("2026-03-01T10:15:42.500Z");

  it("produces events that satisfy the shared event contract", () => {
    const plan = planRun({ mode: "random", count: 100, now });
    expect(plan).toHaveLength(100);
    plan.forEach((planned, index) => {
      const event = buildEvent(planned, { now: now + index });
      expect(eventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true);
      expect(event.source).toBe("simulator");
    });
  });

  it("caps a run at 100 events", () => {
    expect(planRun({ mode: "random", count: 5000, now })).toHaveLength(SIMULATOR_LIMITS.maxEventsPerRun);
  });

  it("builds a spike from one session entirely inside one minute and above the alert threshold", () => {
    const plan = planRun({ mode: "spike", count: 1, now });
    expect(plan).toHaveLength(SIMULATOR_LIMITS.spikeBurstSize);
    expect(plan.length).toBeGreaterThan(SPIKE_RULE.eventsPerSessionPerWindow);
    expect(new Set(plan.map((p) => p.sessionId)).size).toBe(1);
    const minutes = new Set(plan.map((p) => Math.floor(Date.parse(p.timestamp!) / SPIKE_RULE.windowMs)));
    expect(minutes.size).toBe(1);
    expect(plan.every((p) => eventSchema.safeParse(buildEvent(p, { now })).success)).toBe(true);
  });
});

describe("running", () => {
  /** A virtual clock: sleeping advances time instantly, so pacing is observable without waiting. */
  function harness(send: (body: IngestRequest) => Promise<IngestData>) {
    let clock = 1_000_000;
    const sendTimes: number[] = [];
    const bodies: IngestRequest[] = [];
    const generator = new TrafficGenerator({
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      uuid: randomUUID,
      send: async (body) => {
        sendTimes.push(clock);
        bodies.push(body);
        return send(body);
      },
    });
    return { generator, sendTimes, bodies, advance: (ms: number) => (clock += ms) };
  }

  it("sends one event per request at no more than the chosen rate and stamps one runId", async () => {
    const h = harness(async () => ack());
    await h.generator.start({ mode: "random", events: 20, ratePerSecond: 10 });
    const state = h.generator.getSnapshot();
    expect(state).toMatchObject({ status: "completed", accepted: 20, failed: 0, planned: 20, error: null });
    expect(h.bodies.every((b) => b.events.length === 1 && b.runId === state.runId)).toBe(true);
    const gaps = h.sendTimes.slice(1).map((t, i) => t - h.sendTimes[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(100); // never faster than 10 per second
    // Any one-second window contains at most 10 sends.
    for (let i = 0; i + 10 < h.sendTimes.length; i++) expect(h.sendTimes[i + 10] - h.sendTimes[i]).toBeGreaterThanOrEqual(1000);
  });

  it("retries transient failures with the SAME event ids, then succeeds", async () => {
    let calls = 0;
    const h = harness(async () => {
      if (++calls <= 2) throw apiError(503, "kafka_unavailable");
      return ack();
    });
    await h.generator.start({ mode: "random", events: 1, ratePerSecond: 5 });
    expect(h.generator.getSnapshot()).toMatchObject({ status: "completed", accepted: 1, retries: 2, failed: 0 });
    expect(h.bodies).toHaveLength(3);
    expect(new Set(h.bodies.map((b) => b.events[0].eventId)).size).toBe(1);
  });

  it("gives up after the retry budget and reports the failure honestly", async () => {
    const h = harness(async () => {
      throw apiError(503, "kafka_unavailable");
    });
    await h.generator.start({ mode: "random", events: 5, ratePerSecond: 5 });
    expect(h.bodies).toHaveLength(MAX_RETRIES + 1);
    expect(h.generator.getSnapshot()).toMatchObject({ status: "failed", accepted: 0, failed: 1 });
    expect(h.generator.getSnapshot().error).toMatch(/kafka_unavailable/);
  });

  it("retries a short 429 window collision but stops on a long rate limit, 401, and 400", async () => {
    let calls = 0;
    const collision = harness(async () => {
      if (++calls === 1) throw apiError(429, "rate_limited", 1);
      return ack();
    });
    await collision.generator.start({ mode: "random", events: 2, ratePerSecond: 5 });
    expect(collision.generator.getSnapshot()).toMatchObject({ status: "completed", accepted: 2, retries: 1 });

    for (const error of [apiError(429, "rate_limited", 30), apiError(429, "rate_limited"), apiError(401, "unauthorized"), apiError(400, "invalid_request")]) {
      const h = harness(async () => {
        throw error;
      });
      await h.generator.start({ mode: "random", events: 5, ratePerSecond: 5 });
      expect(h.bodies, `${error.status} should be terminal`).toHaveLength(1);
      expect(h.generator.getSnapshot()).toMatchObject({ status: "failed", failed: 1 });
    }
  });

  it("can be stopped and then reports 'stopped' with partial counts", async () => {
    const stopAfter = vi.fn();
    const h = harness(async () => {
      stopAfter();
      if (stopAfter.mock.calls.length === 3) h.generator.stop();
      return ack();
    });
    await h.generator.start({ mode: "random", events: 50, ratePerSecond: 10 });
    expect(h.generator.getSnapshot()).toMatchObject({ status: "stopped", accepted: 3 });
  });

  it("honours Retry-After when it is longer than the backoff", () => {
    expect(retryDelayMs(0, apiError(503, "kafka_unavailable"))).toBe(500);
    expect(retryDelayMs(2, apiError(503, "kafka_unavailable"))).toBe(2000);
    expect(retryDelayMs(0, apiError(429, "rate_limited", 2))).toBe(2000);
  });
});

describe("newId", () => {
  it("uses crypto.randomUUID when it exists", () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("falls back to getRandomValues where randomUUID is unavailable (plain http origins)", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => real.getRandomValues(bytes) });
    try {
      const ids = Array.from({ length: 50 }, () => newId());
      expect(new Set(ids).size).toBe(50);
      for (const id of ids) {
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        // Accepted by the same schema the server validates with.
        expect(eventSchema.safeParse({ eventId: id, type: "page_view", timestamp: new Date().toISOString(), sessionId: id, page: "/", source: "playground" }).success).toBe(true);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
