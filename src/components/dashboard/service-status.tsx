"use client";

import Link from "next/link";
import { ArrowRight, Database, Radio, Server, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber, formatWhen } from "@/lib/format";
import { describeGroup, describeKafkaPublish, describeWorkers, withStaleness, type Described } from "@/lib/client/status";
import type { PollingResult } from "@/lib/client/use-polling";
import { useNow } from "@/lib/client/use-now";
import type { GroupStatus, StatusData } from "@/shared/api";
import { CardSkeleton, QueryBoundary } from "./states";
import { ToneBadge } from "./status-badge";

function Row({ icon, label, status, detail }: { icon: React.ReactNode; label: string; status: Described; detail?: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="text-sm font-medium">{label}</span>
          <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
        </div>
        {detail ? <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">{detail}</p> : null}
      </div>
    </li>
  );
}

function groupDetail(group: GroupStatus, now: number): string {
  if (!group.offsets) return "No offset sample yet";
  return `Lag ${formatNumber(group.offsets.totalLag)} · sampled ${formatWhen(group.offsets.sampledAt, now)}${group.offsets.stale ? " (stale)" : ""}`;
}

function Rows({ data, stale }: { data: StatusData; stale: boolean }) {
  const now = useNow();
  const workers = describeWorkers(data.workers);
  const publish = describeKafkaPublish(data.kafka, now);
  const analytics = data.groups.find((group) => group.key === "analytics");
  const alerts = data.groups.find((group) => group.key === "alerts");
  return (
    <ul className="divide-y">
      <Row
        icon={<Database />}
        label="Database"
        status={withStaleness({ label: "Connected", tone: "ok" }, stale)}
        detail={stale ? "Not confirmed by a recent request" : "MongoDB answered this request"}
      />
      <Row
        icon={<Radio />}
        label="Kafka publishing"
        status={withStaleness(publish, stale)}
        detail={
          data.kafka.lastPublishError && publish.tone === "bad"
            ? `${data.kafka.lastPublishError.message} (${formatWhen(data.kafka.lastPublishError.at, now)})`
            : data.kafka.lastPublishAt
              ? formatWhen(data.kafka.lastPublishAt, now)
              : "No event has been published since the service started"
        }
      />
      <Row
        icon={<Server />}
        label="Workers"
        status={withStaleness(workers, stale)}
        detail={data.workers.length === 0 ? "No worker heartbeat found" : `${data.workers.length} instance${data.workers.length === 1 ? "" : "s"} seen recently`}
      />
      {analytics ? <Row icon={<Workflow />} label="Analytics consumer" status={withStaleness(describeGroup(analytics), stale)} detail={groupDetail(analytics, now)} /> : null}
      {alerts ? <Row icon={<Workflow />} label="Alerts consumer" status={withStaleness(describeGroup(alerts), stale)} detail={groupDetail(alerts, now)} /> : null}
    </ul>
  );
}

/**
 * Compact worker and service status. Anything not reported shows as unknown, and when the status
 * request itself is failing or old nothing is shown as healthy.
 */
export function ServiceStatus({ query, notice = true }: { query: PollingResult<StatusData>; notice?: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>System status</CardTitle>
        <CardDescription>Reported by the API and the workers.</CardDescription>
        <CardAction>
          <Button asChild variant="ghost" size="sm">
            <Link href="/lab">
              Details <ArrowRight />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <QueryBoundary query={query} skeleton={<CardSkeleton rows={5} />} errorTitle="Couldn't load status" notice={notice}>
          {(data) => <Rows data={data} stale={query.isStale} />}
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}
