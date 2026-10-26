import type { Db } from "mongodb";
import { productName } from "@/shared/catalog";
import {
  ACTIVE_SESSION_WINDOW_MINUTES,
  EVENT_TYPES,
  LIVE_SCOPE,
  METRIC_BUCKET_MS,
  QUERY_LIMITS,
  type EventType,
} from "@/shared/constants";
import type { BreakdownRow, ProductRow, SeriesPoint, Totals } from "@/shared/api";
import { floorTo } from "@/shared/time";
import { collections } from "../collections";

/** Aggregations over one result set (`scope`): live, or one replay run. */

export interface StatsWindow {
  scope: string;
  fromMs: number;
  toMs: number;
  chartBucketMs: number;
}

export interface WindowStats {
  totals: Totals;
  series: SeriesPoint[];
  breakdown: BreakdownRow[];
}

export const MAX_CHART_POINTS = 2000;

export function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

const zeroCounts = (): Record<EventType, number> =>
  Object.fromEntries(EVENT_TYPES.map((type) => [type, 0])) as Record<EventType, number>;

export async function readWindowStats(db: Db, window: StatsWindow): Promise<WindowStats> {
  const { scope, fromMs, toMs, chartBucketMs } = window;
  const docs = await collections(db)
    .metricBuckets.find({ scope, bucket: { $gte: new Date(fromMs), $lte: new Date(toMs) } })
    .maxTimeMS(QUERY_LIMITS.maxTimeMs)
    .limit(Math.ceil(((toMs - fromMs) / METRIC_BUCKET_MS) + 2))
    .toArray();

  const first = floorTo(fromMs, chartBucketMs);
  const last = floorTo(toMs, chartBucketMs);
  const points = new Map<number, SeriesPoint>();
  for (let t = first, n = 0; t <= last && n < MAX_CHART_POINTS; t += chartBucketMs, n++) {
    points.set(t, { t: new Date(t).toISOString(), ...zeroCounts() });
  }

  const counts = zeroCounts();
  for (const doc of docs) {
    const point = points.get(floorTo(doc.bucket.getTime(), chartBucketMs));
    for (const type of EVENT_TYPES) {
      const n = doc[type] ?? 0;
      counts[type] += n;
      if (point) point[type] += n;
    }
  }

  const events = EVENT_TYPES.reduce((sum, type) => sum + counts[type], 0);
  return {
    totals: {
      pageViews: counts.page_view,
      productClicks: counts.product_click,
      cartAdditions: counts.add_to_cart,
      cartRemovals: counts.remove_from_cart,
      orders: counts.order_created,
      events,
    },
    series: [...points.values()],
    breakdown: EVENT_TYPES.map((type) => ({ type, count: counts[type], share: share(counts[type], events) })),
  };
}

export interface ProductAggregate {
  productId: string;
  clicks: number;
  cartAdds: number;
}

/** Per-product sums for the window, bounded by `productsMaxGroups`, most-clicked first. */
export async function readProductAggregates(
  db: Db,
  scope: string,
  fromMs: number,
  toMs: number,
): Promise<ProductAggregate[]> {
  const rows = await collections(db)
    .productBuckets.aggregate<{ _id: string; clicks: number; cartAdds: number }>(
      [
        { $match: { scope, bucket: { $gte: new Date(fromMs), $lte: new Date(toMs) } } },
        {
          $group: {
            _id: "$productId",
            clicks: { $sum: { $ifNull: ["$clicks", 0] } },
            cartAdds: { $sum: { $ifNull: ["$cartAdds", 0] } },
          },
        },
        { $sort: { clicks: -1, cartAdds: -1, _id: 1 } },
        { $limit: QUERY_LIMITS.productsMaxGroups },
      ],
      { maxTimeMS: QUERY_LIMITS.maxTimeMs },
    )
    .toArray();
  return rows.map((row) => ({ productId: row._id, clicks: row.clicks, cartAdds: row.cartAdds }));
}

/**
 * Turns aggregates into rows with explicit, zero-safe ratios:
 * cartAddRatio = cartAdds ÷ clicks (null if no clicks); clickShare = clicks ÷ all clicks (null if none).
 */
export function toProductRows(aggregates: ProductAggregate[]): { rows: ProductRow[]; totals: { clicks: number; cartAdds: number } } {
  const totals = aggregates.reduce(
    (sum, row) => ({ clicks: sum.clicks + row.clicks, cartAdds: sum.cartAdds + row.cartAdds }),
    { clicks: 0, cartAdds: 0 },
  );
  const rows = aggregates.map((row) => ({
    productId: row.productId,
    name: productName(row.productId),
    clicks: row.clicks,
    cartAdds: row.cartAdds,
    cartAddRatio: share(row.cartAdds, row.clicks),
    clickShare: share(row.clicks, totals.clicks),
  }));
  return { rows, totals };
}

export async function readActiveSessions(db: Db, nowMs: number): Promise<number> {
  const since = new Date(nowMs - ACTIVE_SESSION_WINDOW_MINUTES * 60_000);
  return collections(db).sessions.countDocuments(
    { scope: LIVE_SCOPE, lastSeen: { $gte: since } },
    { maxTimeMS: QUERY_LIMITS.maxTimeMs },
  );
}

/** Picks a chart bucket width (in minutes) that keeps a span of arbitrary length near 96 points. */
export function chooseBucketMs(spanMs: number): number {
  const candidatesMinutes = [1, 2, 5, 10, 15, 30, 60, 120, 240, 360, 720, 1440];
  const spanMinutes = Math.max(1, spanMs / 60_000);
  const minutes = candidatesMinutes.find((m) => spanMinutes / m <= 96) ?? 1440;
  return minutes * 60_000;
}
