"use client";

import { useMemo } from "react";
import { createColumnHelper, type SortingState } from "@tanstack/react-table";
import { formatNumber, formatPercent } from "@/lib/format";
import type { ProductRow, ProductSortKey } from "@/shared/api";
import { DataTable, type DataTableFeatures } from "./data-table";

export const CART_RATIO_HELP = "Cart additions ÷ product clicks for this product. Shown as — when it has no clicks.";
export const CLICK_SHARE_HELP = "This product's clicks ÷ all product clicks in the selected range.";

const columnHelper = createColumnHelper<DataTableFeatures, ProductRow>();

/** Products as a sortable table from lg up, and as cards below it. Sorting is applied by the server. */
export function ProductsTable({
  items,
  sort,
  order,
  onSortChange,
}: {
  items: ProductRow[];
  sort: ProductSortKey;
  order: "asc" | "desc";
  onSortChange: (sort: ProductSortKey, order: "asc" | "desc") => void;
}) {
  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor("name", {
          id: "name",
          header: "Product",
          cell: (info) => (
            <span className="block min-w-0">
              <span className="block truncate font-medium">{info.getValue()}</span>
              <span className="block truncate font-mono text-xs text-muted-foreground">{info.row.original.productId}</span>
            </span>
          ),
        }),
        columnHelper.accessor("clicks", {
          id: "clicks",
          header: "Clicks",
          meta: { align: "right" },
          cell: (info) => formatNumber(info.getValue()),
        }),
        columnHelper.accessor("cartAdds", {
          id: "cartAdds",
          header: "Cart adds",
          meta: { align: "right" },
          cell: (info) => formatNumber(info.getValue()),
        }),
        columnHelper.accessor("cartAddRatio", {
          id: "cartAddRatio",
          header: "Cart-add ratio",
          meta: { align: "right", help: CART_RATIO_HELP },
          cell: (info) => formatPercent(info.getValue(), 1),
        }),
        columnHelper.accessor("clickShare", {
          id: "clickShare",
          header: "Click share",
          meta: { align: "right", help: CLICK_SHARE_HELP },
          cell: (info) => formatPercent(info.getValue(), 1),
        }),
      ]),
    [],
  );

  const sorting: SortingState = [{ id: sort, desc: order === "desc" }];
  const onSortingChange = (next: SortingState) => {
    const first = next[0];
    if (first) onSortChange(first.id as ProductSortKey, first.desc ? "desc" : "asc");
  };

  return (
    <>
      <div className="hidden lg:block">
        <DataTable
          columns={columns}
          data={items}
          getRowId={(row) => row.productId}
          caption="Product clicks and cart additions"
          sorting={sorting}
          onSortingChange={onSortingChange}
        />
      </div>
      <ul className="grid gap-2 lg:hidden" aria-label="Product clicks and cart additions">
        {items.map((product) => (
          <li key={product.productId} className="rounded-xl border bg-card p-3">
            <p className="truncate font-medium">{product.name}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">{product.productId}</p>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Clicks</dt>
                <dd className="font-medium tabular-nums">{formatNumber(product.clicks)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Cart adds</dt>
                <dd className="font-medium tabular-nums">{formatNumber(product.cartAdds)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Cart-add ratio</dt>
                <dd className="font-medium tabular-nums">{formatPercent(product.cartAddRatio, 1)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Click share</dt>
                <dd className="font-medium tabular-nums">{formatPercent(product.clickShare, 1)}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}
