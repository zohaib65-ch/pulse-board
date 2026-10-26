"use client";

import { useState } from "react";
import { Pause, Play } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAdmin } from "@/lib/client/admin-token";
import { ApiError } from "@/lib/client/api";
import { describeGroup, withStaleness } from "@/lib/client/status";
import { useNow } from "@/lib/client/use-now";
import { formatNumber, formatOffset, formatRelative, formatWhen } from "@/lib/format";
import type { ConsumerControlData, GroupStatus } from "@/shared/api";
import type { ConsumerAction } from "@/shared/api";
import { WORKER } from "@/shared/constants";
import { AdminRequired } from "../admin-button";
import { ToneBadge } from "../status-badge";

const GROUP_COPY = {
  analytics: { title: "Analytics consumer", purpose: "Calculates the dashboard statistics from every event." },
  alerts: { title: "Alerts consumer", purpose: "Watches for unusually busy sessions and raises in-app alerts." },
} as const;

function effectiveText(group: GroupStatus, stale: boolean): string {
  const prefix = stale ? "Last known, workers reported: " : "Workers report: ";
  switch (group.effective) {
    case "running":
      return `${prefix}running`;
    case "paused":
      return `${prefix}paused`;
    case "mixed":
      return `${prefix}applying the change`;
    case "no_workers":
      return stale ? "Last known: no live worker was reporting" : "No live worker is reporting";
  }
}

function GroupCard({ group, stale, onChanged }: { group: GroupStatus; stale: boolean; onChanged: () => void }) {
  const { adminPost, isUnlocked } = useAdmin();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const copy = GROUP_COPY[group.key];
  const state = withStaleness(describeGroup(group), stale);
  const offsets = group.offsets;

  async function apply(action: ConsumerAction) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await adminPost<ConsumerControlData>(`/api/consumers/${group.key}`, { action });
      setMessage({
        tone: "ok",
        text: `${action === "pause" ? "Pause" : "Resume"} saved at ${formatWhen(result.updatedAt, now)}. Workers pick it up within a few seconds.`,
      });
      onChanged();
    } catch (cause) {
      setMessage({ tone: "error", text: cause instanceof ApiError ? `${cause.message} [${cause.code}]` : "The request failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>
          <code className="font-mono text-xs break-all">{group.groupId}</code>
          <span className="mt-1 block">{copy.purpose}</span>
        </CardDescription>
        <CardAction>
          <ToneBadge tone={state.tone}>{state.label}</ToneBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 text-sm">
            <p>
              Desired state: <span className="font-medium">{group.paused ? "Paused" : "Running"}</span>
              <span className="text-muted-foreground">
                {group.paused && group.pausedAt ? ` since ${formatWhen(group.pausedAt, now)}` : ""} · stored in MongoDB, applied by every worker
              </span>
            </p>
            <p className="text-muted-foreground">{effectiveText(group, stale)}</p>
          </div>
          {group.paused ? (
            <Button type="button" onClick={() => void apply("resume")} disabled={!isUnlocked || busy}>
              <Play /> Resume
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="outline" disabled={!isUnlocked || busy}>
                  <Pause /> Pause
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Pause the {copy.title.toLowerCase()}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Workers stop processing events for <span className="font-mono text-xs">{group.groupId}</span>. Ingestion keeps accepting events and Kafka keeps them, so the lag grows until you resume. Nothing is lost: after Resume the consumer continues from its committed offset and catches up.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void apply("pause")}>Pause consumer</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>

        <div aria-live="polite">
          {message ? (
            <Alert variant={message.tone === "error" ? "destructive" : "default"}>
              <AlertDescription className={message.tone === "ok" ? "text-foreground" : undefined}>{message.text}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        {offsets ? (
          <div className="space-y-2">
            <div className="overflow-x-auto rounded-xl border">
              <Table>
                <caption className="sr-only">Committed and latest offsets per partition for {group.groupId}</caption>
                <TableHeader className="bg-muted/40">
                  <TableRow className="hover:bg-transparent">
                    <TableHead scope="col">Partition</TableHead>
                    <TableHead scope="col" className="text-right">Committed</TableHead>
                    <TableHead scope="col" className="text-right">Latest</TableHead>
                    <TableHead scope="col" className="text-right">Lag</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {offsets.partitions.map((partition) => (
                    <TableRow key={partition.partition}>
                      <TableCell className="tabular-nums">{partition.partition}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatOffset(partition.committed)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatOffset(partition.latest)}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{formatNumber(partition.lag)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell colSpan={3} className="font-medium">Total lag (approximate)</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{formatNumber(offsets.totalLag)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground tabular-nums">
              Sampled by a worker at {formatWhen(offsets.sampledAt, now)}
              {now > 0 ? ` (${formatRelative(offsets.sampledAt, now)})` : ""}. Lag is the log end minus the committed offset, so it is approximate between samples.
            </p>
            {offsets.stale ? (
              <Alert>
                <AlertDescription className="text-foreground">
                  This sample is older than {Math.round(WORKER.offsetStaleAfterMs / 1000)} seconds. The numbers may be out of date, for example if no worker is running.
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No offset sample yet. Offsets appear once a worker has started and sampled this group.</p>
        )}
      </CardContent>
    </Card>
  );
}

/** One card per consumer group: persisted pause state, effective state, and per-partition offsets. */
export function ConsumersPanel({ groups, stale, onChanged }: { groups: GroupStatus[]; stale: boolean; onChanged: () => void }) {
  return (
    <div className="space-y-4">
      <AdminRequired id="consumers-locked">Pausing and resuming consumers needs the admin token.</AdminRequired>
      {groups.map((group) => (
        <GroupCard key={group.key} group={group} stale={stale} onChanged={onChanged} />
      ))}
    </div>
  );
}
