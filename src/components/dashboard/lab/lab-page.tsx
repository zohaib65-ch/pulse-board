"use client";

import { useStatus } from "@/lib/client/hooks";
import { useTrafficGenerator } from "@/lib/client/use-traffic-generator";
import { PageHeader } from "../page-header";
import { Freshness, QueryBoundary, CardSkeleton } from "../states";
import { ConsumersPanel } from "./consumers-panel";
import { ReplayPanel } from "./replay-panel";
import { SendEventsCard } from "./send-events-card";
import { TrafficGeneratorCard } from "./traffic-generator-card";
import { WorkersList } from "./workers-list";

/**
 * Produce on the left, watch consumption on the right. Sending events and seeing the lag move in
 * the same view is the point of the lab.
 */
export function LabPage() {
  const status = useStatus();
  const generator = useTrafficGenerator();

  return (
    <>
      <PageHeader
        title="Kafka Lab"
        description="Publish events, pause a consumer while ingestion continues, watch it catch up, and replay what Kafka retains."
        actions={<Freshness query={status} />}
      />
      <div className="space-y-6">
        <div className="grid gap-6 xl:grid-cols-2">
          <div className="min-w-0 space-y-6">
            <SendEventsCard />
            <TrafficGeneratorCard state={generator.state} onStart={generator.start} onStop={generator.stop} />
          </div>
          <div className="min-w-0 space-y-6">
            <QueryBoundary query={status} skeleton={<CardSkeleton rows={8} />} errorTitle="Couldn't load consumer status">
              {(data) => (
                <>
                  <ConsumersPanel groups={data.groups} stale={status.isStale} onChanged={status.refresh} />
                  <WorkersList workers={data.workers} stale={status.isStale} />
                </>
              )}
            </QueryBoundary>
          </div>
        </div>
        <ReplayPanel />
      </div>
    </>
  );
}
