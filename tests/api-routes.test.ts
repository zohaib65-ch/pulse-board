import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { INGEST_LIMITS } from "@/shared/constants";
import { collections } from "@/lib/server/collections";
import { closeMongo } from "@/lib/server/mongo";
import { createTestDb } from "./helpers/db";
import { makeEvent } from "./helpers/events";

// Kafka is mocked at the module boundary; everything else (routes, auth, validation, rate limits,
// MongoDB) is real. These tests prove the HTTP contract, not a live Kafka connection.
vi.mock("@/lib/server/kafka", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/kafka")>();
  return { ...actual, publishEvents: vi.fn() };
});

const TOKEN = "t".repeat(40);
let t: Awaited<ReturnType<typeof createTestDb>>;
let publishEvents: ReturnType<typeof vi.fn>;
let routes: {
  events: typeof import("@/app/api/events/route");
  consumers: typeof import("@/app/api/consumers/[group]/route");
  replays: typeof import("@/app/api/replays/route");
  verify: typeof import("@/app/api/admin/verify/route");
  overview: typeof import("@/app/api/metrics/overview/route");
  status: typeof import("@/app/api/status/route");
};

beforeAll(async () => {
  t = await createTestDb();
  process.env.MONGODB_URI = t.uri;
  process.env.ADMIN_TOKEN = TOKEN;
  ({ publishEvents } = (await import("@/lib/server/kafka")) as unknown as { publishEvents: ReturnType<typeof vi.fn> });
  routes = {
    events: await import("@/app/api/events/route"),
    consumers: await import("@/app/api/consumers/[group]/route"),
    replays: await import("@/app/api/replays/route"),
    verify: await import("@/app/api/admin/verify/route"),
    overview: await import("@/app/api/metrics/overview/route"),
    status: await import("@/app/api/status/route"),
  };
});

afterAll(async () => {
  await closeMongo();
  await t.drop();
});

beforeEach(() => {
  publishEvents.mockReset();
  publishEvents.mockResolvedValue([{ partition: 1, baseOffset: "42" }]);
});

let ipCounter = 0;
/** Each request gets its own client address so failed-auth counters do not leak between tests. */
function request(path: string, init: { method?: string; token?: string | null; body?: unknown; ip?: string; raw?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": init.ip ?? `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`,
    ...init.headers,
  };
  if (init.token !== null && init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
  return new Request(`http://localhost${path}`, {
    method: init.method ?? "POST",
    headers,
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Envelope = { ok: boolean; data: Record<string, any>; error: Record<string, any> };
/* eslint-enable @typescript-eslint/no-explicit-any */
const json = async (response: Response) => (await response.json()) as Envelope;
const batch = (n = 1) => ({ events: Array.from({ length: n }, () => makeEvent()) });
const groupCtx = (group: string) => ({ params: Promise.resolve({ group }) });

/** Rate limits use wall-clock seconds; start from the beginning of a second so two quick calls share one window. */
async function alignToSecond() {
  const wait = 1000 - (Date.now() % 1000);
  if (wait < 800) await new Promise((resolve) => setTimeout(resolve, wait + 20));
}

describe("unauthorized writes are refused before anything happens", () => {
  it.each([
    ["no token", null],
    ["wrong token", "wrong-token-value-wrong-token-value"],
    ["empty bearer", ""],
    ["almost-right token", `${TOKEN}x`],
  ])("POST /api/events with %s → 401 and nothing is published", async (_name, token) => {
    const res = await routes.events.POST(request("/api/events", { token, body: batch() }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    expect(await json(res)).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(publishEvents).not.toHaveBeenCalled();
  });

  it("does not leak validation details to unauthenticated callers", async () => {
    const res = await routes.events.POST(request("/api/events", { token: null, body: { events: [{ junk: true }] } }));
    expect(res.status).toBe(401);
    expect((await json(res)).error.issues).toBeUndefined();
  });

  it("protects every control endpoint", async () => {
    const pause = await routes.consumers.POST(request("/api/consumers/analytics", { body: { action: "pause" } }), groupCtx("analytics"));
    const replay = await routes.replays.POST(request("/api/replays", { body: {} }));
    const verify = await routes.verify.POST(request("/api/admin/verify", {}));
    expect([pause.status, replay.status, verify.status]).toEqual([401, 401, 401]);
    expect(await collections(t.db).commands.countDocuments({})).toBe(0);
    expect(await collections(t.db).replayJobs.countDocuments({})).toBe(0);
  });

  it("locks a client out after repeated failures, even with the right token, and does not lock others out", async () => {
    const ip = "203.0.113.9";
    for (let i = 0; i < 10; i++) {
      expect((await routes.verify.POST(request("/api/admin/verify", { ip, token: "nope-nope-nope-nope-nope-nope" }))).status).toBe(401);
    }
    const blocked = await routes.verify.POST(request("/api/admin/verify", { ip, token: TOKEN }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await routes.verify.POST(request("/api/admin/verify", { ip: "198.51.100.1", token: TOKEN }))).status).toBe(200);
  });
});

describe("auth lockout under concurrency", () => {
  it("compares at most 10 wrong guesses out of a burst of 200 (the rest are refused unevaluated)", async () => {
    const ip = "198.51.100.77";
    const results = await Promise.all(
      Array.from({ length: 200 }, () => routes.verify.POST(request("/api/admin/verify", { ip, token: "nope-nope-nope-nope-nope-nope" }))),
    );
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 401)).toHaveLength(10);
    expect(codes.filter((c) => c === 429)).toHaveLength(190);
  });

  it("a correct token hands its slot back, so legitimate use is never locked out", async () => {
    const ip = "198.51.100.78";
    for (let i = 0; i < 9; i++) {
      expect((await routes.verify.POST(request("/api/admin/verify", { ip, token: "wrong-wrong-wrong-wrong-wrong" }))).status).toBe(401);
    }
    for (let i = 0; i < 15; i++) {
      expect((await routes.verify.POST(request("/api/admin/verify", { ip, token: TOKEN }))).status).toBe(200);
    }
  });
});

describe("POST /api/events", () => {
  it("publishes a valid batch and answers 202 only after Kafka acknowledged it", async () => {
    const body = batch(3);
    const res = await routes.events.POST(request("/api/events", { token: TOKEN, body }));
    expect(res.status).toBe(202);
    const payload = await json(res);
    expect(payload).toMatchObject({ ok: true, data: { accepted: 3, acks: [{ partition: 1, baseOffset: "42" }] } });
    expect(payload.data.eventIds).toEqual(body.events.map((e) => e.eventId));
    expect(publishEvents).toHaveBeenCalledTimes(1);
    expect(publishEvents.mock.calls[0][0]).toEqual(body.events);
    expect((await collections(t.db).serviceState.findOne({ _id: "ingest" }))?.lastPublishAt).toBeInstanceOf(Date);
  });

  it("does not claim success when Kafka does not acknowledge (503, honest message, same eventIds reusable)", async () => {
    const { PublishError } = await import("@/lib/server/kafka");
    publishEvents.mockRejectedValueOnce(new PublishError("connect ECONNREFUSED kafka-secret-host.aivencloud.com:12345"));
    const body = batch(1);
    const res = await routes.events.POST(request("/api/events", { token: TOKEN, body }));
    expect(res.status).toBe(503);
    const payload = await json(res);
    expect(payload).toMatchObject({ ok: false, error: { code: "kafka_unavailable" } });
    expect(JSON.stringify(payload)).not.toContain("kafka-secret-host");

    const state = await collections(t.db).serviceState.findOne({ _id: "ingest" });
    expect(state?.lastError?.message).toBe("Could not reach the Kafka brokers."); // sanitized, no hostnames
    const status = await json(await routes.status.GET(request("/api/status", { method: "GET" })));
    expect(status.data.kafka.lastPublishError.message).not.toContain("aivencloud");

    // The client retries with the very same eventIds and it succeeds.
    const retry = await routes.events.POST(request("/api/events", { token: TOKEN, body }));
    expect(retry.status).toBe(202);
    expect(publishEvents.mock.calls[1][0][0].eventId).toBe(body.events[0].eventId);
  });

  it.each([
    ["missing productId on a click", { events: [makeEvent({ type: "product_click" })] }],
    ["bad uuid", { events: [{ ...makeEvent(), eventId: "abc" }] }],
    ["query string in page", { events: [makeEvent({ page: "/p?email=a@b.c" })] }],
    ["empty batch", { events: [] }],
    [`more than ${INGEST_LIMITS.maxBatchSize} events`, batch(INGEST_LIMITS.maxBatchSize + 1)],
    ["unknown top-level field", { ...batch(), extra: 1 }],
    ["old timestamp", { events: [makeEvent({ timestamp: new Date(Date.now() - 2 * 86_400_000).toISOString() })] }],
    ["future timestamp", { events: [makeEvent({ timestamp: new Date(Date.now() + 3_600_000).toISOString() })] }],
    ["simulator without runId", { events: [makeEvent({ source: "simulator" })] }],
  ])("rejects %s with 400 and field issues", async (_name, body) => {
    const res = await routes.events.POST(request("/api/events", { token: TOKEN, body }));
    expect(res.status).toBe(400);
    const payload = await json(res);
    expect(payload.error.code).toBe("invalid_request");
    expect(payload.error.issues?.length).toBeGreaterThan(0);
    expect(publishEvents).not.toHaveBeenCalled();
  });

  it("rejects non-JSON bodies, wrong content types, and oversized payloads", async () => {
    expect((await routes.events.POST(request("/api/events", { token: TOKEN, raw: "{oops" }))).status).toBe(400);
    expect((await routes.events.POST(request("/api/events", { token: TOKEN, raw: "{}", headers: { "content-type": "text/plain" } }))).status).toBe(400);
    const huge = JSON.stringify({ events: [makeEvent()], pad: "x".repeat(INGEST_LIMITS.maxBodyBytes) });
    const declared = await routes.events.POST(request("/api/events", { token: TOKEN, raw: huge }));
    expect(declared.status).toBe(413);
    expect(publishEvents).not.toHaveBeenCalled();
  });

  it("enforces the simulator limits in MongoDB: 10 events per second and 100 per run", async () => {
    let runId = "";
    const sim = (n: number) => ({ runId, events: Array.from({ length: n }, () => makeEvent({ source: "simulator" })) });

    // Limits are per wall-clock second, so a trial only counts if both requests landed in the same
    // second; on a slow or busy machine a pair can straddle a boundary, in which case try again.
    let proven = false;
    for (let attempt = 0; attempt < 5 && !proven; attempt++) {
      await alignToSecond();
      runId = randomUUID();
      publishEvents.mockClear();
      const second = Math.floor(Date.now() / 1000);
      const ok = await routes.events.POST(request("/api/events", { token: TOKEN, body: sim(10) }));
      const tooFast = await routes.events.POST(request("/api/events", { token: TOKEN, body: sim(1) }));
      if (Math.floor(Date.now() / 1000) !== second) continue;
      expect(ok.status).toBe(202);
      expect(tooFast.status).toBe(429);
      expect((await json(tooFast)).error).toMatchObject({ code: "rate_limited", retryAfterSeconds: expect.any(Number) });
      expect(publishEvents).toHaveBeenCalledTimes(1);
      proven = true;
    }
    expect(proven).toBe(true);

    // Per-run cap: after 100 events in total, further events for this run are refused.
    let sent = 10;
    while (sent < 100) {
      await new Promise((resolve) => setTimeout(resolve, 1050));
      const res = await routes.events.POST(request("/api/events", { token: TOKEN, body: sim(10) }));
      expect(res.status).toBe(202);
      sent += 10;
    }
    await new Promise((resolve) => setTimeout(resolve, 1050));
    const over = await routes.events.POST(request("/api/events", { token: TOKEN, body: sim(1) }));
    expect(over.status).toBe(429);
    expect((await json(over)).error.message).toMatch(/100 events/);
  }, 90_000);
});

describe("control endpoints", () => {
  it("verifies a token for real", async () => {
    const res = await routes.verify.POST(request("/api/admin/verify", { token: TOKEN }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, data: { verified: true } });
  });

  it("pauses and resumes a group through the persisted command, validating the request", async () => {
    const pause = await routes.consumers.POST(request("/api/consumers/analytics", { token: TOKEN, body: { action: "pause" } }), groupCtx("analytics"));
    expect(pause.status).toBe(200);
    expect(await json(pause)).toMatchObject({ ok: true, data: { key: "analytics", paused: true } });
    expect((await collections(t.db).commands.findOne({ _id: "analytics" }))?.paused).toBe(true);

    const resume = await routes.consumers.POST(request("/api/consumers/analytics", { token: TOKEN, body: { action: "resume" } }), groupCtx("analytics"));
    expect((await json(resume)).data.paused).toBe(false);

    const unknownGroup = await routes.consumers.POST(request("/api/consumers/billing", { token: TOKEN, body: { action: "pause" } }), groupCtx("billing"));
    const badAction = await routes.consumers.POST(request("/api/consumers/alerts", { token: TOKEN, body: { action: "delete" } }), groupCtx("alerts"));
    expect([unknownGroup.status, badAction.status]).toEqual([400, 400]);
  });

  it("creates a replay job (202) and refuses a second while one is active (409)", async () => {
    const created = await routes.replays.POST(request("/api/replays", { token: TOKEN, body: {} }));
    expect(created.status).toBe(202);
    expect((await json(created)).data).toMatchObject({ status: "queued", progress: 0 });
    const second = await routes.replays.POST(request("/api/replays", { token: TOKEN, body: {} }));
    expect(second.status).toBe(409);
    const bad = await routes.replays.POST(request("/api/replays", { token: TOKEN, body: { everything: true } }));
    expect(bad.status).toBe(400);
  });
});

describe("public read endpoints", () => {
  it("serve dashboard data without a token and validate query parameters", async () => {
    const overview = await routes.overview.GET(request("/api/metrics/overview?range=15m", { method: "GET" }));
    expect(overview.status).toBe(200);
    expect((await json(overview)).data).toMatchObject({ range: "15m", totals: { events: expect.any(Number) } });

    const badRange = await routes.overview.GET(request("/api/metrics/overview?range=7d", { method: "GET" }));
    const unknownParam = await routes.overview.GET(request("/api/metrics/overview?debug=1", { method: "GET" }));
    expect([badRange.status, unknownParam.status]).toEqual([400, 400]);

    const ids = "11111111-1111-4111-8111-111111111111";
    const lookup = await routes.events.GET(request(`/api/events?ids=${ids}`, { method: "GET" }));
    expect((await json(lookup)).data.items).toEqual([]);
    for (const bad of ["not-a-uuid", Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`).join(","), ""]) {
      expect((await routes.events.GET(request(`/api/events?ids=${bad}`, { method: "GET" }))).status).toBe(400);
    }

    const status = await routes.status.GET(request("/api/status", { method: "GET" }));
    const data = (await json(status)).data;
    expect(data).toMatchObject({ database: { ok: true }, kafka: { topic: "website-events", partitions: 2 } });
    expect(JSON.stringify(data)).not.toMatch(/mongodb|BEGIN|ADMIN|password/i);
  });
});
