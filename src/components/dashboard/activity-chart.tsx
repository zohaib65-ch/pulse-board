"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatClock, formatCompact, formatDateTime, formatNumber } from "@/lib/format";
import type { OverviewData } from "@/shared/api";
import { EVENT_TYPES, RANGES } from "@/shared/constants";
import { EVENT_STYLE } from "./event-style";
import { EmptyState, LabLink } from "./states";
import { BarChart3 } from "lucide-react";

const chartConfig = {
  page_view: { label: EVENT_STYLE.page_view.plural, color: EVENT_STYLE.page_view.color },
  product_click: { label: EVENT_STYLE.product_click.plural, color: EVENT_STYLE.product_click.color },
  add_to_cart: { label: EVENT_STYLE.add_to_cart.plural, color: EVENT_STYLE.add_to_cart.color },
} satisfies ChartConfig;

const TOTAL_KEYS = { page_view: "pageViews", product_click: "productClicks", add_to_cart: "cartAdditions" } as const;

function Legend({ data }: { data: OverviewData }) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm" aria-label="Series">
      {EVENT_TYPES.map((type) => (
        <li key={type} className="flex items-center gap-2">
          <span aria-hidden className="h-0.5 w-4 rounded-full" style={{ background: EVENT_STYLE[type].color }} />
          <span className="text-muted-foreground">{EVENT_STYLE[type].plural}</span>
          <span className="font-medium tabular-nums">{formatNumber(data.totals[TOTAL_KEYS[type]])}</span>
        </li>
      ))}
    </ul>
  );
}

function ActivityAreaChart({ data }: { data: OverviewData }) {
  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-[260px] w-full sm:h-[320px] xl:h-[380px]">
      <AreaChart accessibilityLayer data={data.series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="t"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={36}
          interval="preserveStartEnd"
          tickFormatter={(value: string) => formatClock(value)}
        />
        <YAxis tickLine={false} axisLine={false} width={36} allowDecimals={false} tickFormatter={(value: number) => formatCompact(value)} />
        <ChartTooltip
          cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1, strokeOpacity: 0.4 }}
          content={<ChartTooltipContent indicator="line" labelFormatter={(label) => formatDateTime(String(label))} />}
        />
        {EVENT_TYPES.map((type) => (
          <Area
            key={type}
            dataKey={type}
            type="monotone"
            stroke={`var(--color-${type})`}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill={`var(--color-${type})`}
            fillOpacity={0.1}
            dot={false}
            activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  );
}

function ActivityTable({ data }: { data: OverviewData }) {
  const rows = [...data.series].reverse();
  return (
    <div className="max-h-[320px] overflow-auto rounded-lg border sm:max-h-[380px]">
      <Table>
        <TableHeader className="sticky top-0 bg-card">
          <TableRow>
            <TableHead scope="col">Bucket start</TableHead>
            {EVENT_TYPES.map((type) => (
              <TableHead key={type} scope="col" className="text-right">
                {EVENT_STYLE[type].plural}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((point) => (
            <TableRow key={point.t}>
              <TableCell className="tabular-nums">{formatClock(point.t)}</TableCell>
              {EVENT_TYPES.map((type) => (
                <TableCell key={type} className="text-right tabular-nums">
                  {formatNumber(point[type])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * The visual focus of the dashboard: events per time bucket for the selected range.
 * `data` is null while the current range is loading.
 */
export function ActivityChart({ data }: { data: OverviewData | null }) {
  return (
    <Card className="[--card-spacing:--spacing(4)] md:[--card-spacing:--spacing(6)]">
      <Tabs defaultValue="chart" className="gap-4">
        <CardHeader>
          <CardTitle className="text-lg">Activity</CardTitle>
          <CardDescription>
            {data
              ? `Events per ${data.bucketMinutes} ${data.bucketMinutes === 1 ? "minute" : "minutes"} · ${RANGES[data.range].label.toLowerCase()}`
              : "Events over time"}
          </CardDescription>
          <CardAction>
            <TabsList aria-label="Chart or table view">
              <TabsTrigger value="chart">Chart</TabsTrigger>
              <TabsTrigger value="table">Table</TabsTrigger>
            </TabsList>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          {data === null ? (
            <Skeleton className="h-[300px] w-full sm:h-[380px] xl:h-[440px]" role="status" aria-label="Loading chart" />
          ) : (
            <div className="space-y-4">
              <Legend data={data} />
              {data.totals.events === 0 ? (
                <EmptyState icon={<BarChart3 aria-hidden />} title="No events in this range yet" className="h-[260px] sm:h-[320px] xl:h-[380px]">
                  Events appear here once the analytics consumer has processed them. Send some from the <LabLink>Kafka Lab</LabLink>.
                </EmptyState>
              ) : (
                <>
                  <TabsContent value="chart" className="mt-0">
                    <ActivityAreaChart data={data} />
                  </TabsContent>
                  <TabsContent value="table" className="mt-0">
                    <ActivityTable data={data} />
                  </TabsContent>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Tabs>
    </Card>
  );
}
