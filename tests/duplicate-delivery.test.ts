import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSUMER_GROUP_IDS, SPIKE_RULE } from "@/shared/constants";
import { collections } from "@/lib/server/collections";
import { processAlertsMessage } from "@/lib/server/processing/alerts";
import { processAnalyticsMessage } from "@/lib/server/processing/analytics";
import { getOverview } from "@/lib/server/queries/overview";
import { getAlerts } from "@/lib/server/queries/alerts";
import { createTestDb } from "./helpers/db";
import { makeEvent, toMessages } from "./helpers/events";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());

const live = { kind: "live", groupId: CONSUMER_GROUP_IDS.analytics } as const;

describe("duplicate delivery (at-least-once in, exactly-once effect)", () => {
  it("leaves every total unchanged when a message is delivered again", async () => {
    const click = makeEvent({ type: "product_click", productId: "cedar-notebook" });
    const view = makeEvent({ type: "page_view" });
    const messages = toMessages([click, view]);

    const first = await Promise.all(messages.map((m) => processAnalyticsMessage(t, live, m)));
    expect(first.map((o) => o.status)).toEqual(["applied", "applied"]);
    const before = await getOverview(t.db, "15m");

    // Redelivered after a crash/rebalance: same eventIds at the same (or even new) offsets.
    const second = await Promise.all(messages.map((m) => processAnalyticsMessage(t, live, m)));
    const moved = await processAnalyticsMessage(t, live, { ...messages[0], partition: 1, offset: "99" });
    expect(second.map((o) => o.status)).toEqual(["duplicate", "duplicate"]);
    expect(moved.status).toBe("duplicate");

    const after = await getOverview(t.db, "15m");
    expect(after.totals).toEqual(before.totals);
    expect(after.totals).toMatchObject({ pageViews: 1, productClicks: 1, cartAdditions: 0, events: 2 });
    expect(after.topProducts[0]).toMatchObject({ productId: "cedar-notebook", clicks: 1 });
    expect(await collections(t.db).events.countDocuments({ _id: { $in: [click.eventId, view.eventId] } })).toBe(2);
  });

  it("stays exact when the same message is processed concurrently (two workers racing)", async () => {
    const event = makeEvent({ type: "add_to_cart", productId: "ember-wool-throw" });
    const [message] = toMessages([event]);
    const before = (await getOverview(t.db, "15m")).totals.cartAdditions;

    const outcomes = await Promise.all(Array.from({ length: 8 }, () => processAnalyticsMessage(t, live, message)));

    expect(outcomes.filter((o) => o.status === "applied")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "duplicate")).toHaveLength(7);
    expect((await getOverview(t.db, "15m")).totals.cartAdditions).toBe(before + 1);
  });

  it("deduplicates each consumer group independently", async () => {
    const event = makeEvent({ type: "page_view" });
    const [message] = toMessages([event]);

    const analytics = await processAnalyticsMessage(t, live, message);
    const alerts = await processAlertsMessage(t, CONSUMER_GROUP_IDS.alerts, message);
    expect(analytics.status).toBe("applied");
    expect(alerts.status).toBe("applied"); // the analytics group having seen it does not skip the alerts group

    expect((await processAlertsMessage(t, CONSUMER_GROUP_IDS.alerts, message)).status).toBe("duplicate");
    const ids = await collections(t.db).dedupe.find({ _id: { $regex: event.eventId } }).toArray();
    expect(ids.map((d) => d.groupId).sort()).toEqual([CONSUMER_GROUP_IDS.alerts, CONSUMER_GROUP_IDS.analytics].sort());
  });

  it("creates exactly one spike alert per session and window, even with redelivery", async () => {
    const sessionId = randomUUID();
    const windowStart = "2026-03-01T10:15:00.000Z";
    const total = SPIKE_RULE.eventsPerSessionPerWindow + 10;
    const events = Array.from({ length: total }, (_, i) =>
      makeEvent({ sessionId, timestamp: new Date(Date.parse(windowStart) + i * 500).toISOString() }),
    );
    const messages = toMessages(events);
    const quiet = toMessages([makeEvent({ timestamp: windowStart })], { startOffset: 500 });

    // Events arrive twice: the whole stream is redelivered.
    for (const pass of [1, 2]) {
      for (const message of [...messages, ...quiet]) {
        await processAlertsMessage(t, CONSUMER_GROUP_IDS.alerts, message, new Date("2026-03-01T10:16:00Z"));
      }
      expect(pass).toBeGreaterThan(0);
    }

    const alerts = await collections(t.db).alerts.find({ sessionId }).toArray();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "session_spike", threshold: SPIKE_RULE.eventsPerSessionPerWindow });
    expect(alerts[0].windowStart.toISOString()).toBe(windowStart);
    const window = await collections(t.db).alertWindows.findOne({ sessionId });
    expect(window?.count).toBe(total); // redelivery did not inflate the counter
    expect((await getAlerts(t.db, 10)).items.some((a) => a.sessionId === sessionId)).toBe(true);
  });

  it("keeps spike counters alive from processing time, so a lagging group cannot lose them to TTL", async () => {
    const sessionId = randomUUID();
    // An event timestamped months ago, processed now (a group that was paused or far behind).
    const old = makeEvent({ sessionId, timestamp: "2026-03-01T09:00:10.000Z" });
    await processAlertsMessage(t, CONSUMER_GROUP_IDS.alerts, toMessages([old])[0]);
    const first = await collections(t.db).alertWindows.findOne({ sessionId });
    expect(first!.expireAt.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);

    // Every further event pushes the expiry forward; it never moves backwards.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = makeEvent({ sessionId, timestamp: "2026-03-01T09:00:20.000Z" });
    await processAlertsMessage(t, CONSUMER_GROUP_IDS.alerts, toMessages([second], { startOffset: 1 })[0]);
    const after = await collections(t.db).alertWindows.findOne({ sessionId });
    expect(after!.count).toBe(2);
    expect(after!.expireAt.getTime()).toBeGreaterThanOrEqual(first!.expireAt.getTime());
  });

  it("does not alert at exactly the threshold, only above it", async () => {
    const sessionId = randomUUID();
    const base = Date.parse("2026-03-01T11:00:00Z");
    const events = Array.from({ length: SPIKE_RULE.eventsPerSessionPerWindow }, (_, i) =>
      makeEvent({ sessionId, timestamp: new Date(base + i * 100).toISOString() }),
    );
    for (const m of toMessages(events)) await processAlertsMessage(t, CONSUMER_GROUP_IDS.alerts, m);
    expect(await collections(t.db).alerts.countDocuments({ sessionId })).toBe(0);
  });
});

describe("malformed messages", () => {
  it("are recorded as rejected, never throw, and do not block the messages after them", async () => {
    const good = makeEvent({ type: "page_view" });
    const batch = toMessages(["{not json", JSON.stringify({ eventId: "x" }), JSON.stringify(good)], { partition: 1, startOffset: 700 });

    const outcomes = [];
    for (const message of batch) outcomes.push(await processAnalyticsMessage(t, live, message));
    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected", "applied"]);

    // Redelivery of the same offsets does not create more rejections.
    for (const message of batch) await processAnalyticsMessage(t, live, message);
    const rejected = await collections(t.db).rejected.find({ partition: 1, offset: { $in: ["700", "701"] } }).toArray();
    expect(rejected).toHaveLength(2);
    expect(rejected.map((r) => r.reason).sort()[0]).toMatch(/invalid event|not valid JSON/);
    expect(await collections(t.db).events.countDocuments({ _id: good.eventId })).toBe(1);
  });

  it("treats an empty message and a far-future timestamp as rejected", async () => {
    const future = makeEvent({ timestamp: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    const empty = { partition: 1, offset: "800", value: null };
    const [futureMessage] = toMessages([future], { partition: 1, startOffset: 801 });
    expect((await processAnalyticsMessage(t, live, empty)).status).toBe("rejected");
    expect((await processAnalyticsMessage(t, live, futureMessage)).status).toBe("rejected");
  });
});
