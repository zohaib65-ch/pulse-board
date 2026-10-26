import type { Db } from "mongodb";
import { LIVE_SCOPE, type RangeKey } from "@/shared/constants";
import type { ProductRow, ProductSortKey, ProductsData } from "@/shared/api";
import { rangeWindow } from "@/shared/time";
import { readProductAggregates, toProductRows } from "./stats";

export interface ProductsQuery {
  range: RangeKey;
  q: string;
  sort: ProductSortKey;
  order: "asc" | "desc";
  page: number;
  pageSize: number;
}

/** Null ratios sort last in either direction so "—" rows never lead the table. */
function compare(a: ProductRow, b: ProductRow, sort: ProductSortKey, order: "asc" | "desc"): number {
  const direction = order === "asc" ? 1 : -1;
  if (sort === "name") return direction * a.name.localeCompare(b.name) || a.productId.localeCompare(b.productId);
  const x = a[sort];
  const y = b[sort];
  if (x === null && y === null) return a.productId.localeCompare(b.productId);
  if (x === null) return 1;
  if (y === null) return -1;
  return direction * (x - y) || a.productId.localeCompare(b.productId);
}

export async function getProducts(db: Db, query: ProductsQuery, now: Date = new Date()): Promise<ProductsData> {
  const window = rangeWindow(query.range, now.getTime());
  const aggregates = await readProductAggregates(db, LIVE_SCOPE, window.fromMs, window.toMs);
  // Shares are relative to ALL products in the range, so compute them before searching.
  const { rows: allRows } = toProductRows(aggregates);

  const needle = query.q.toLowerCase();
  const matching = needle
    ? allRows.filter((row) => row.name.toLowerCase().includes(needle) || row.productId.includes(needle))
    : allRows;
  const totals = matching.reduce(
    (sum, row) => ({ clicks: sum.clicks + row.clicks, cartAdds: sum.cartAdds + row.cartAdds }),
    { clicks: 0, cartAdds: 0 },
  );

  matching.sort((a, b) => compare(a, b, query.sort, query.order));
  const totalItems = matching.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / query.pageSize));
  const page = Math.min(query.page, totalPages);
  const start = (page - 1) * query.pageSize;

  return {
    range: query.range,
    from: new Date(window.fromMs).toISOString(),
    to: new Date(window.toMs).toISOString(),
    generatedAt: now.toISOString(),
    items: matching.slice(start, start + query.pageSize),
    totals,
    page,
    pageSize: query.pageSize,
    totalItems,
    totalPages,
    sort: query.sort,
    order: query.order,
    q: query.q,
  };
}
