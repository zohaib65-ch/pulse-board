"use client";

import { useAlerts, useOverview, useStatus } from "@/lib/client/hooks";
import { useRange } from "@/lib/client/range-provider";
import { ActivityChart } from "./activity-chart";
import { AlertsPanel } from "./alerts-panel";
import { EventBreakdown } from "./event-breakdown";
import { MetricStrip } from "./metric-strip";
import { PageHeader } from "./page-header";
import { RangeSelect } from "./range-select";
import { ServiceStatus } from "./service-status";
import { ErrorPanel, Freshness, StaleNotice } from "./states";
import { TopProducts } from "./top-products";

export function OverviewPage() {
  const { range } = useRange();
  const overview = useOverview(range);
  const alerts = useAlerts(5);
  const status = useStatus();

  // Numbers belong to one range. While another range loads (or fails) nothing from the previous
  // range stays on screen under the new range's label: cards show skeletons, or one error panel.
  const overviewData = overview.currentData;
  const overviewFailed = overviewData === null && overview.error !== null;

  // One combined notice (and one Retry) when refreshes fail but older data is still shown.
  const stale = [overview, alerts, status].filter((query) => query.currentData !== null && query.error !== null);
  const staleSince = stale.reduce<number | null>(
    (oldest, query) => (query.lastUpdatedAt === null ? oldest : oldest === null ? query.lastUpdatedAt : Math.min(oldest, query.lastUpdatedAt)),
    null,
  );

  return (
    <>
      <PageHeader
        title="Overview"
        description="Website activity as it flows through Kafka, processed by independent consumers into MongoDB."
        actions={
          <>
            <RangeSelect />
            <Freshness query={overview} />
          </>
        }
      />
      {stale.length > 0 && stale[0]?.error ? (
        <StaleNotice error={stale[0].error} lastUpdatedAt={staleSince} onRetry={() => stale.forEach((query) => query.refresh())} />
      ) : null}
      <div className="space-y-6">
        {overviewFailed && overview.error ? (
          <ErrorPanel error={overview.error} onRetry={overview.refresh} title="Couldn't load the overview" />
        ) : (
          <>
            <MetricStrip data={overviewData} />
            <ActivityChart data={overviewData} />
          </>
        )}
        <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
          {overviewFailed ? null : (
            <>
              <div className="min-w-0 xl:col-span-2">
                <TopProducts data={overviewData} />
              </div>
              <div className="min-w-0">
                <EventBreakdown data={overviewData} />
              </div>
            </>
          )}
          <div className="min-w-0 xl:col-span-2">
            <AlertsPanel query={alerts} notice={false} />
          </div>
          <div className="min-w-0">
            <ServiceStatus query={status} notice={false} />
          </div>
        </div>
      </div>
    </>
  );
}
