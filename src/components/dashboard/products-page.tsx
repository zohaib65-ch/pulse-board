"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Package, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useProducts } from "@/lib/client/hooks";
import { useRange } from "@/lib/client/range-provider";
import { useKeyedState } from "@/lib/client/use-keyed-state";
import { useDebouncedValue } from "@/lib/client/use-debounced-value";
import { formatNumber } from "@/lib/format";
import { PRODUCT_SORT_KEYS, type ProductSortKey } from "@/shared/api";
import { QUERY_LIMITS } from "@/shared/constants";
import { PageHeader } from "./page-header";
import { ProductsTable } from "./products-table";
import { RangeSelect } from "./range-select";
import { EmptyState, Freshness, LabLink, QueryBoundary } from "./states";

const SORT_LABELS: Record<ProductSortKey, string> = {
  name: "Name",
  clicks: "Clicks",
  cartAdds: "Cart adds",
  cartAddRatio: "Cart-add ratio",
  clickShare: "Click share",
};

export function ProductsPage() {
  const { range } = useRange();
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search.trim(), 300);
  const [sort, setSort] = useState<ProductSortKey>("clicks");
  const [order, setOrder] = useState<"asc" | "desc">("desc");

  // The page number belongs to one combination of range, search and sort; any change starts again
  // at page 1, even when it changes back to an earlier combination.
  const [page, setPage] = useKeyedState(`${range}|${q}|${sort}|${order}`, 1);

  const query = useProducts({ range, q, sort, order, page, pageSize: QUERY_LIMITS.productsDefaultPageSize });

  const changeSort = (nextSort: ProductSortKey, nextOrder: "asc" | "desc") => {
    setSort(nextSort);
    setOrder(nextOrder);
  };

  return (
    <>
      <PageHeader
        title="Products"
        description="Clicks and cart additions per product. Search, sorting and paging run on the server."
        actions={
          <>
            <RangeSelect />
            <Freshness query={query} />
          </>
        }
      />

      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto] sm:items-end">
          <Field>
            <FieldLabel htmlFor="product-search">Search products</FieldLabel>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                id="product-search"
                type="search"
                value={search}
                maxLength={QUERY_LIMITS.maxSearchLength}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Name or product id"
                autoComplete="off"
                className="pl-9"
              />
            </div>
          </Field>
          <Field>
            <FieldLabel htmlFor="product-sort">Sort by</FieldLabel>
            <Select value={sort} onValueChange={(value) => changeSort(value as ProductSortKey, order)}>
              <SelectTrigger id="product-sort" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {PRODUCT_SORT_KEYS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {SORT_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOrder(order === "asc" ? "desc" : "asc")}
            aria-label={`Sort order: ${order === "asc" ? "ascending" : "descending"}. Switch to ${order === "asc" ? "descending" : "ascending"}`}
          >
            {order === "asc" ? <ArrowUp /> : <ArrowDown />}
            {order === "asc" ? "Ascending" : "Descending"}
          </Button>
        </div>

        <QueryBoundary
          query={query}
          errorTitle="Couldn't load products"
          skeleton={
            <div className="space-y-2" role="status" aria-label="Loading products">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-12 w-full" />
              ))}
            </div>
          }
        >
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState icon={<Package aria-hidden />} title={q ? "No products match your search" : "No product activity in this range"}>
                {q ? (
                  <>Nothing matches “{q}”. Try a different name or id.</>
                ) : (
                  <>
                    Product clicks and cart additions appear here once they are processed. Send some from the <LabLink>Kafka Lab</LabLink>.
                  </>
                )}
              </EmptyState>
            ) : (
              <>
                <p className="text-sm text-muted-foreground tabular-nums">
                  {formatNumber(data.totalItems)} {data.totalItems === 1 ? "product" : "products"} · {formatNumber(data.totals.clicks)} clicks ·{" "}
                  {formatNumber(data.totals.cartAdds)} cart additions across all matches
                </p>
                <ProductsTable items={data.items} sort={data.sort} order={data.order} onSortChange={changeSort} />
                <nav aria-label="Products pagination" className="flex flex-wrap items-center justify-between gap-3 pt-2">
                  <p className="text-sm text-muted-foreground tabular-nums">
                    Page {data.page} of {Math.max(1, data.totalPages)}
                  </p>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" disabled={data.page <= 1 || query.isPlaceholderData} onClick={() => setPage(data.page - 1)}>
                      <ChevronLeft /> Previous
                    </Button>
                    <Button type="button" variant="outline" disabled={data.page >= data.totalPages || query.isPlaceholderData} onClick={() => setPage(data.page + 1)}>
                      Next <ChevronRight />
                    </Button>
                  </div>
                </nav>
              </>
            )
          }
        </QueryBoundary>

        <section aria-label="How the percentages are defined" className="rounded-xl border bg-muted/30 p-4 text-sm text-muted-foreground">
          <p>
            <strong className="font-medium text-foreground">Cart-add ratio</strong> = cart additions ÷ product clicks for the product; — when there are no clicks. It can exceed 100% because cart additions are not linked to individual clicks.{" "}
            <strong className="font-medium text-foreground">Click share</strong> = product clicks ÷ all product clicks in the range.
          </p>
        </section>
      </div>
    </>
  );
}
