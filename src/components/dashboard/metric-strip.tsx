"use client";

import { Users } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/format";
import type { OverviewData } from "@/shared/api";
import { RANGES } from "@/shared/constants";
import { EVENT_STYLE } from "./event-style";

interface Tile {
  key: string;
  label: string;
  value: number;
  caption: string;
  icon: React.ReactNode;
}

function tiles(data: OverviewData): Tile[] {
  const rangeLabel = RANGES[data.range].label.toLowerCase();
  const eventTile = (type: keyof typeof EVENT_STYLE, value: number): Tile => {
    const { plural, color, icon: Icon } = EVENT_STYLE[type];
    return {
      key: type,
      label: plural,
      value,
      caption: rangeLabel,
      icon: <Icon className="size-4" style={{ color }} aria-hidden />,
    };
  };
  return [
    eventTile("page_view", data.totals.pageViews),
    eventTile("product_click", data.totals.productClicks),
    eventTile("add_to_cart", data.totals.cartAdditions),
    eventTile("remove_from_cart", data.totals.cartRemovals),
    eventTile("order_created", data.totals.orders),
    {
      key: "sessions",
      label: "Active sessions",
      value: data.activeSessions.count,
      caption: `last ${data.activeSessions.windowMinutes} minutes · not affected by range`,
      icon: <Users className="size-4 text-muted-foreground" aria-hidden />,
    },
  ];
}

/**
 * Compact metric strip: totals for the selected range plus sessions active in the last five minutes.
 * `data` is null while the numbers for the current range are loading, so numbers from a previous
 * range are never shown under the new range's label.
 */
export function MetricStrip({ data }: { data: OverviewData | null }) {
  return (
    <section aria-labelledby="key-metrics-heading">
      <h2 id="key-metrics-heading" className="sr-only">
        Key metrics
      </h2>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border ring-1 ring-foreground/10 xl:grid-cols-3">
        {data === null
          ? Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="space-y-3 bg-card p-4 md:p-5" role="status" aria-label="Loading metric">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-20" />
                <Skeleton className="h-3 w-28" />
              </div>
            ))
          : tiles(data).map((tile) => (
              <div key={tile.key} className="min-w-0 bg-card p-4 md:p-5">
                <dt className="flex items-center gap-2 text-sm text-muted-foreground">
                  {tile.icon}
                  <span className="truncate">{tile.label}</span>
                </dt>
                <dd className="mt-2 text-2xl font-semibold tracking-tight tabular-nums md:text-3xl">{formatNumber(tile.value)}</dd>
                <dd className="mt-1 text-xs text-muted-foreground">{tile.caption}</dd>
              </div>
            ))}
      </dl>
    </section>
  );
}
