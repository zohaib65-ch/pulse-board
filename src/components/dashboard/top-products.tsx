"use client";

import Link from "next/link";
import { ArrowRight, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";
import type { OverviewData } from "@/shared/api";
import { RANGES } from "@/shared/constants";
import { CardSkeleton, EmptyState, LabLink } from "./states";

function Products({ data }: { data: OverviewData }) {
  if (data.topProducts.length === 0) {
    return (
      <EmptyState icon={<Package aria-hidden />} title="No product activity in this range">
        Product clicks and cart additions show up here. Try the <LabLink>Kafka Lab</LabLink>.
      </EmptyState>
    );
  }
  const maxClicks = Math.max(1, ...data.topProducts.map((product) => product.clicks));
  return (
    <ol className="space-y-4">
      {data.topProducts.map((product, index) => (
        <li key={product.productId} className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">{index + 1}</span>
              <span className="truncate font-medium">{product.name}</span>
            </span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              <span className="font-medium text-foreground">{formatNumber(product.clicks)}</span> clicks ·{" "}
              <span className="font-medium text-foreground">{formatNumber(product.cartAdds)}</span> carts
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted" role="presentation">
            <div className="h-full rounded-full bg-chart-2 transition-[width]" style={{ width: `${(product.clicks / maxClicks) * 100}%` }} />
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Top five products by clicks in the selected range. `data` is null while the current range is loading. */
export function TopProducts({ data }: { data: OverviewData | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top products</CardTitle>
        <CardDescription>{data ? `By clicks · ${RANGES[data.range].label.toLowerCase()}` : "By clicks"}</CardDescription>
        <CardAction>
          <Button asChild variant="ghost" size="sm">
            <Link href="/products">
              All products <ArrowRight />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>{data === null ? <CardSkeleton rows={5} /> : <Products data={data} />}</CardContent>
    </Card>
  );
}
