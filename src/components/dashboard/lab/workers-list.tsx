"use client";

import { Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { withStaleness } from "@/lib/client/status";
import { useNow } from "@/lib/client/use-now";
import { formatAge, formatDateTime, formatPercent, formatRelative, shortId } from "@/lib/format";
import type { WorkerStatus } from "@/shared/api";
import { CONSUMER_GROUP_IDS, CONSUMER_KEYS } from "@/shared/constants";
import { EmptyState } from "../states";
import { ToneBadge } from "../status-badge";

function partitionText(partitions: number[]): string {
  return partitions.length === 0 ? "no partitions" : `partition${partitions.length === 1 ? "" : "s"} ${partitions.join(", ")}`;
}

const groupLabel = (key: (typeof CONSUMER_KEYS)[number]) => CONSUMER_GROUP_IDS[key].replace("pulseboard-", "").replace("-v1", "");

/** What a worker last reported, written as history rather than as a live claim. */
function lastKnownState(worker: WorkerStatus): string {
  const groups = CONSUMER_KEYS.map((key) => `${groupLabel(key)} ${worker.groups[key].state} (${partitionText(worker.groups[key].partitions)})`).join("; ");
  return `${groups}; Kafka ${worker.kafkaConnected ? "connected" : "disconnected"}`;
}

function StaleWorker({ worker, now }: { worker: WorkerStatus; now: number }) {
  return (
    <li className="space-y-2 rounded-xl border border-dashed bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          Instance <span className="font-mono text-xs">{shortId(worker.instanceId)}</span>
        </p>
        <ToneBadge tone="bad">Stale</ToneBadge>
      </div>
      <p className="text-sm text-muted-foreground tabular-nums">
        No heartbeat for {now > 0 ? formatAge(worker.lastHeartbeatAt, now) : "a while"} · last known state: {lastKnownState(worker)}
      </p>
      <p className="text-xs text-muted-foreground tabular-nums">
        Last heartbeat {formatDateTime(worker.lastHeartbeatAt)} · started {formatDateTime(worker.startedAt)}
      </p>
    </li>
  );
}

function LiveWorker({ worker, now, stale }: { worker: WorkerStatus; now: number; stale: boolean }) {
  const live = withStaleness({ label: "Live", tone: "ok" }, stale);
  const kafka = withStaleness({ label: worker.kafkaConnected ? "Kafka connected" : "Kafka disconnected", tone: worker.kafkaConnected ? "ok" : "bad" }, stale);
  return (
    <li className="space-y-2 rounded-xl border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          Instance <span className="font-mono text-xs">{shortId(worker.instanceId)}</span>
        </p>
        <div className="flex flex-wrap gap-1.5">
          <ToneBadge tone={live.tone}>{live.label}</ToneBadge>
          <ToneBadge tone={kafka.tone}>{kafka.label}</ToneBadge>
        </div>
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        Last heartbeat {now > 0 ? formatRelative(worker.lastHeartbeatAt, now) : formatDateTime(worker.lastHeartbeatAt)} · started {formatDateTime(worker.startedAt)}
      </p>
      <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
        {CONSUMER_KEYS.map((key) => {
          const group = worker.groups[key];
          return (
            <li key={key} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-muted-foreground">{groupLabel(key)}:</span>
              <Badge variant="outline">{group.state}</Badge>
              <span className="tabular-nums">{partitionText(group.partitions)}</span>
              {group.lastError ? <span className="w-full text-xs text-destructive">{group.lastError}</span> : null}
            </li>
          );
        })}
      </ul>
      {worker.replay ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          Running replay <span className="font-mono">{shortId(worker.replay.runId)}</span> · {formatPercent(worker.replay.progress, 0)}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Every worker instance that has reported in. A worker whose heartbeat has stopped is shown as
 * history ("no heartbeat for 3m, last known state …"), never with live-looking badges.
 * `stale` means the status request itself is failing or old.
 */
export function WorkersList({ workers, stale }: { workers: WorkerStatus[]; stale: boolean }) {
  const now = useNow();
  const live = workers.filter((worker) => !worker.stale).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Workers</CardTitle>
        <CardDescription>
          Instances of the background worker. Within a consumer group, the topic&apos;s partitions are shared between live instances; start a second one to watch them rebalance.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {workers.length === 0 ? (
          <EmptyState icon={<Server aria-hidden />} title="No worker has reported in">
            Start one with <code className="font-mono text-xs">npm run dev:worker</code> or deploy the daemon. Dashboards stay empty until a worker processes events.
          </EmptyState>
        ) : (
          <>
            {stale ? (
              <p className="mb-3 text-sm text-muted-foreground">The status request is failing or out of date, so these are the last known values, not current ones.</p>
            ) : null}
            <ul className="space-y-3">
              {workers.map((worker) =>
                worker.stale ? (
                  <StaleWorker key={worker.instanceId} worker={worker} now={now} />
                ) : (
                  <LiveWorker key={worker.instanceId} worker={worker} now={now} stale={stale} />
                ),
              )}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              {live} live {live === 1 ? "instance" : "instances"}. A worker is marked stale when its heartbeat stops, and its partitions move to the others after Kafka detects it.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
