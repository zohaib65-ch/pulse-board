"use client";

import { PieChart } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber, formatPercent } from "@/lib/format";
import type { OverviewData } from "@/shared/api";
import { EVENT_TYPES, RANGES } from "@/shared/constants";
import { EVENT_STYLE } from "./event-style";
import { CardSkeleton, EmptyState } from "./states";

function Breakdown({ data }: { data: OverviewData }) {
  if (data.totals.events === 0) {
    return (
      <EmptyState icon={<PieChart aria-hidden />} title="No events in this range">
        Nothing to break down yet.
      </EmptyState>
    );
  }
  return (
    <ul className="space-y-4">
      {EVENT_TYPES.map((type) => {
        const row = data.breakdown.find((item) => item.type === type);
        const share = row?.share ?? null;
        return (
          <li key={type} className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: EVENT_STYLE[type].color }} />
                <span className="truncate">{EVENT_STYLE[type].plural}</span>
              </span>
              <span className="shrink-0 tabular-nums">
                <span className="font-medium">{formatNumber(row?.count ?? 0)}</span>
                <span className="ml-2 text-muted-foreground">{formatPercent(share, 1)}</span>
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted" role="presentation">
              <div
                className="h-full rounded-full transition-[width]"
                style={{ width: `${Math.max(0, Math.min(100, (share ?? 0) * 100))}%`, background: EVENT_STYLE[type].color }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Share of each event type in the selected range. Fixed order, so each type keeps its color.
 * `data` is null while the current range is loading.
 */
export function EventBreakdown({ data }: { data: OverviewData | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Event types</CardTitle>
        <CardDescription>{data ? RANGES[data.range].label : "Selected range"}</CardDescription>
      </CardHeader>
      <CardContent>{data === null ? <CardSkeleton rows={EVENT_TYPES.length} /> : <Breakdown data={data} />}</CardContent>
    </Card>
  );
}
