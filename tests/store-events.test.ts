import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSUMER_GROUP_IDS } from "@/shared/constants";
import { eventSchema } from "@/shared/event-schema";
import { collections } from "@/lib/server/collections";
import { validateBatch } from "@/lib/server/ingest";
import { processAnalyticsMessage } from "@/lib/server/processing/analytics";
import { getEvents } from "@/lib/server/queries/events";
import { getOverview } from "@/lib/server/queries/overview";
import { getProducts } from "@/lib/server/queries/products";
import { createTestDb } from "./helpers/db";
import { makeEvent, toMessages } from "./helpers/events";

const store = (overrides: Parameters<typeof makeEvent>[0] = {}) => makeEvent({ source: "store", ...overrides });

describe("storefront events: schema", () => {
  it("accepts the store source without a runId", () => {
    expect(eventSchema.safeParse(store()).success).toBe(true);
    expect(() => validateBatch({ events: [store()] })).not.toThrow();
  });

  it("requires productId for remove_from_cart", () => {
    const result = eventSchema.safeParse(store({ type: "remove_from_cart" }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["productId"]);
    expect(eventSchema.safeParse(store({ type: "remove_from_cart", productId: "cedar-notebook" })).success).toBe(true);
  });

  it("accepts order_created without a product and rejects one with a product", () => {
    expect(eventSchema.safeParse(store({ type: "order_created", page: "/order/success" })).success).toBe(true);
    const result = eventSchema.safeParse(store({ type: "order_created", productId: "cedar-notebook" }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/not allowed for order_created/);
  });

  it("still rejects sources outside the contract", () => {
    expect(eventSchema.safeParse(makeEvent({ source: "browser" as never })).success).toBe(false);
  });

  it("accepts Mongo ObjectId-style product ids (the store's fallback when a slug does not fit)", () => {
    expect(eventSchema.safeParse(store({ type: "product_click", productId: "65a1b2c3d4e5f60718293a4b" })).success).toBe(true);
  });
});

describe("storefront events: processing", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  const live = { kind: "live", groupId: CONSUMER_GROUP_IDS.analytics } as const;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t.drop());

  it("counts removals and orders as their own metrics without touching per-product cart additions", async () => {
    const add = store({ type: "add_to_cart", productId: "cedar-notebook", page: "/product/cedar-notebook" });
    const remove = store({ type: "remove_from_cart", productId: "cedar-notebook", page: "/cart" });
    const order = store({ type: "order_created", page: "/order/success" });
    for (const message of toMessages([add, remove, order])) {
      expect((await processAnalyticsMessage(t, live, message)).status).toBe("applied");
    }

    const overview = await getOverview(t.db, "15m");
    expect(overview.totals).toEqual({ pageViews: 0, productClicks: 0, cartAdditions: 1, cartRemovals: 1, orders: 1, events: 3 });
    expect(overview.breakdown.map((row) => [row.type, row.count])).toEqual([
      ["page_view", 0],
      ["product_click", 0],
      ["add_to_cart", 1],
      ["remove_from_cart", 1],
      ["order_created", 1],
    ]);
    // The removal must not inflate the product's cart additions (the pre-extension code would have).
    expect(overview.topProducts).toHaveLength(1);
    expect(overview.topProducts[0]).toMatchObject({ productId: "cedar-notebook", clicks: 0, cartAdds: 1 });
    const products = await getProducts(t.db, { range: "15m", q: "", sort: "clicks", order: "desc", page: 1, pageSize: 10 });
    expect(products.totals).toEqual({ clicks: 0, cartAdds: 1 });
  });

  it("stores the source and lets the events list filter the new types", async () => {
    const removals = await getEvents(t.db, { range: "15m", type: "remove_from_cart", limit: 10 });
    expect(removals.items).toHaveLength(1);
    expect(removals.items[0]).toMatchObject({ type: "remove_from_cart", source: "store", productId: "cedar-notebook" });
    const orders = await getEvents(t.db, { range: "15m", type: "order_created", limit: 10 });
    expect(orders.items[0]).toMatchObject({ source: "store", productId: null, page: "/order/success" });
  });

  it("counts a redelivered order exactly once", async () => {
    const order = store({ type: "order_created", page: "/order/success" });
    const [message] = toMessages([order]);
    const before = (await getOverview(t.db, "15m")).totals.orders;

    const outcomes = await Promise.all([1, 2, 3].map(() => processAnalyticsMessage(t, live, message)));

    expect(outcomes.filter((o) => o.status === "applied")).toHaveLength(1);
    expect((await getOverview(t.db, "15m")).totals.orders).toBe(before + 1);
    expect(await collections(t.db).events.countDocuments({ _id: order.eventId })).toBe(1);
  });

  it("rejects an order_created message that carries a productId instead of counting it", async () => {
    const bad = { ...store({ type: "order_created" }), productId: "cedar-notebook" };
    const [message] = toMessages([bad]);
    const outcome = await processAnalyticsMessage(t, live, message);
    expect(outcome).toMatchObject({ status: "rejected" });
    expect(await collections(t.db).events.countDocuments({ _id: bad.eventId })).toBe(0);
  });

  it("keeps the original three event types behaving exactly as before", async () => {
    const isolated = await createTestDb();
    const events = [
      makeEvent({ type: "page_view" }),
      makeEvent({ type: "product_click", productId: "aurora-desk-lamp" }),
      makeEvent({ type: "add_to_cart", productId: "aurora-desk-lamp", sessionId: randomUUID() }),
    ];
    for (const message of toMessages(events)) await processAnalyticsMessage(isolated, live, message);
    const overview = await getOverview(isolated.db, "15m");
    expect(overview.totals).toEqual({ pageViews: 1, productClicks: 1, cartAdditions: 1, cartRemovals: 0, orders: 0, events: 3 });
    expect(overview.topProducts[0]).toMatchObject({ productId: "aurora-desk-lamp", clicks: 1, cartAdds: 1 });
    await isolated.drop();
  });
});
