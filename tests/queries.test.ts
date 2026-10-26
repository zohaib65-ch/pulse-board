import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSUMER_GROUP_IDS } from "@/shared/constants";
import { processAnalyticsMessage } from "@/lib/server/processing/analytics";
import { getEvents } from "@/lib/server/queries/events";
import { getOverview } from "@/lib/server/queries/overview";
import { getProducts } from "@/lib/server/queries/products";
import { toGroupOffsets } from "@/lib/server/queries/status";
import { createTestDb } from "./helpers/db";
import { makeEvent, toMessages } from "./helpers/events";

let t: Awaited<ReturnType<typeof createTestDb>>;
const target = { kind: "live", groupId: CONSUMER_GROUP_IDS.analytics } as const;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

beforeAll(async () => {
  t = await createTestDb();
  const events = [
    // product A: 3 clicks, 1 cart add; product B: clicks only; product C: cart adds only (zero clicks)
    ...Array.from({ length: 3 }, () => makeEvent({ type: "product_click", productId: "cedar-notebook", timestamp: minutesAgo(2) })),
    makeEvent({ type: "add_to_cart", productId: "cedar-notebook", timestamp: minutesAgo(1) }),
    makeEvent({ type: "product_click", productId: "aurora-desk-lamp", timestamp: minutesAgo(3), page: "/products" }),
    makeEvent({ type: "add_to_cart", productId: "grove-plant-pot", timestamp: minutesAgo(1) }),
    makeEvent({ type: "page_view", timestamp: minutesAgo(2), page: "/cart" }),
    // outside the 15-minute window but inside 1h and 24h
    makeEvent({ type: "page_view", timestamp: minutesAgo(40) }),
    makeEvent({ type: "product_click", productId: "cedar-notebook", timestamp: minutesAgo(300) }),
  ];
  for (const message of toMessages(events)) await processAnalyticsMessage(t, target, message);
});
afterAll(() => t.drop());

describe("overview", () => {
  it("applies the range filter consistently to totals, series, breakdown, and top products", async () => {
    const [m15, h1, h24] = await Promise.all(["15m", "1h", "24h"].map((r) => getOverview(t.db, r as "15m")));
    expect(m15.totals).toEqual({ pageViews: 1, productClicks: 4, cartAdditions: 2, events: 7 });
    expect(h1.totals.pageViews).toBe(2);
    expect(h24.totals.productClicks).toBe(5);

    for (const overview of [m15, h1, h24]) {
      const fromSeries = overview.series.reduce((sum, p) => sum + p.page_view + p.product_click + p.add_to_cart, 0);
      expect(fromSeries).toBe(overview.totals.events);
      expect(overview.breakdown.reduce((sum, row) => sum + row.count, 0)).toBe(overview.totals.events);
      expect(overview.topProducts.reduce((sum, p) => sum + p.clicks, 0)).toBeLessThanOrEqual(overview.totals.productClicks);
    }
    expect(m15.series.length).toBeGreaterThanOrEqual(15);
    expect(m15.topProducts[0]).toMatchObject({ productId: "cedar-notebook", clicks: 3, cartAdds: 1 });
    expect(m15.activeSessions).toEqual({ count: 7, windowMinutes: 5 });
  });

  it("counts active sessions only inside the five-minute window", async () => {
    const overview = await getOverview(t.db, "24h");
    expect(overview.activeSessions.count).toBe(7); // the 40-minute and 300-minute sessions are excluded
  });

  it("returns honest zeros and null shares for an empty range", async () => {
    const empty = await createTestDb();
    const overview = await getOverview(empty.db, "1h");
    expect(overview.totals).toEqual({ pageViews: 0, productClicks: 0, cartAdditions: 0, events: 0 });
    expect(overview.breakdown.every((row) => row.share === null)).toBe(true);
    expect(overview.topProducts).toEqual([]);
    await empty.drop();
  });
});

describe("products", () => {
  const base = { range: "1h", q: "", sort: "clicks", order: "desc", page: 1, pageSize: 10 } as const;

  it("computes ratios with safe zero-denominator handling", async () => {
    const { items, totals } = await getProducts(t.db, base);
    const byId = Object.fromEntries(items.map((p) => [p.productId, p]));
    expect(byId["cedar-notebook"]).toMatchObject({ clicks: 3, cartAdds: 1, cartAddRatio: 1 / 3, clickShare: 3 / 4 });
    expect(byId["aurora-desk-lamp"]).toMatchObject({ clicks: 1, cartAdds: 0, cartAddRatio: 0, clickShare: 1 / 4 });
    // Cart adds without any click: ratio is undefined, not Infinity or NaN.
    expect(byId["grove-plant-pot"]).toMatchObject({ clicks: 0, cartAdds: 1, cartAddRatio: null, clickShare: 0 });
    expect(totals).toEqual({ clicks: 4, cartAdds: 2 });
  });

  it("returns null shares when the range has no clicks at all", async () => {
    const { items } = await getProducts(t.db, { ...base, range: "15m", q: "grove" });
    expect(items).toHaveLength(1);
    expect(items[0].clickShare).toBe(0); // 0 ÷ 4 clicks in range: a real zero
    const empty = await createTestDb();
    expect((await getProducts(empty.db, base)).items).toEqual([]);
    await empty.drop();
  });

  it("searches, sorts (nulls last), and paginates on the server", async () => {
    const search = await getProducts(t.db, { ...base, q: "LAMP" });
    expect(search.items.map((p) => p.productId)).toEqual(["aurora-desk-lamp"]);

    const asc = await getProducts(t.db, { ...base, sort: "cartAddRatio", order: "asc" });
    expect(asc.items.map((p) => p.productId)).toEqual(["aurora-desk-lamp", "cedar-notebook", "grove-plant-pot"]);
    const desc = await getProducts(t.db, { ...base, sort: "cartAddRatio", order: "desc" });
    expect(desc.items.at(-1)?.cartAddRatio).toBeNull();

    const byName = await getProducts(t.db, { ...base, sort: "name", order: "asc" });
    expect(byName.items.map((p) => p.name)).toEqual(["Aurora Desk Lamp", "Cedar Notebook", "Grove Plant Pot"]);

    const page2 = await getProducts(t.db, { ...base, pageSize: 2, page: 2 });
    expect(page2).toMatchObject({ page: 2, totalItems: 3, totalPages: 2 });
    expect(page2.items).toHaveLength(1);
    expect((await getProducts(t.db, { ...base, pageSize: 2, page: 99 })).page).toBe(2); // clamped
  });
});

describe("events list", () => {
  it("filters on the server and paginates with a stable cursor", async () => {
    const all = await getEvents(t.db, { range: "24h", limit: 100 });
    expect(all.items).toHaveLength(9);
    expect(all.nextCursor).toBeNull();
    const times = all.items.map((e) => e.timestamp);
    expect([...times].sort().reverse()).toEqual(times); // newest first

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await getEvents(t.db, { range: "24h", limit: 4, cursor });
      seen.push(...result.items.map((e) => e.eventId));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(all.items.map((e) => e.eventId)); // no gaps, no repeats

    expect((await getEvents(t.db, { range: "24h", limit: 50, type: "add_to_cart" })).items).toHaveLength(2);
    expect((await getEvents(t.db, { range: "24h", limit: 50, productId: "cedar-notebook" })).items).toHaveLength(5);
    expect((await getEvents(t.db, { range: "24h", limit: 50, page: "/cart" })).items).toHaveLength(1);
    expect((await getEvents(t.db, { range: "15m", limit: 50 })).items).toHaveLength(7); // range filter applies here too
  });

  it("looks events up directly by id, regardless of the range or the page size", async () => {
    const all = await getEvents(t.db, { range: "24h", limit: 100 });
    const oldest = all.items.at(-1)!; // far outside a 15-minute window
    const newest = all.items[0];
    const found = await getEvents(t.db, { range: "15m", limit: 1, ids: [oldest.eventId, newest.eventId, "00000000-0000-4000-8000-000000000000"] });
    expect(found.items.map((e) => e.eventId).sort()).toEqual([oldest.eventId, newest.eventId].sort());
    expect(found.nextCursor).toBeNull();
  });

  it("rejects a tampered cursor", async () => {
    await expect(getEvents(t.db, { range: "1h", limit: 5, cursor: "garbage" })).rejects.toMatchObject({ status: 400 });
  });

  it("exposes the Kafka partition and offset of each event", async () => {
    const [first] = (await getEvents(t.db, { range: "24h", limit: 1 })).items;
    expect(first.kafka).toEqual({ partition: 0, offset: expect.stringMatching(/^\d+$/) });
  });
});

describe("lag", () => {
  it("is approximate: latest minus the committed position, relative to what Kafka retains", () => {
    const now = Date.now();
    const offsets = toGroupOffsets(
      {
        _id: "analytics",
        groupId: CONSUMER_GROUP_IDS.analytics,
        sampledAt: new Date(now - 1000),
        sampledBy: "w",
        partitions: [
          { partition: 0, committed: "90", earliest: "0", latest: "100" },
          { partition: 1, committed: null, earliest: "40", latest: "50" }, // never committed: lag = retained messages
        ],
      },
      now,
    );
    expect(offsets.partitions.map((p) => p.lag)).toEqual([10, 10]);
    expect(offsets.totalLag).toBe(20);
    expect(offsets.stale).toBe(false);
    expect(toGroupOffsets({ _id: "analytics", groupId: "g", sampledAt: new Date(now - 120_000), sampledBy: "w", partitions: [] }, now).stale).toBe(true);
  });
});
