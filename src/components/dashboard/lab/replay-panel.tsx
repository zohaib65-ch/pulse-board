"use client";

import { useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAdmin } from "@/lib/client/admin-token";
import { ApiError } from "@/lib/client/api";
import { useReplayDetail, useReplays } from "@/lib/client/hooks";
import { describeReplayStatus, isReplayActive } from "@/lib/client/status";
import { formatDateTime, formatNumber, formatOffset, formatPercent, shortId } from "@/lib/format";
import type { ReplayJobData, ReplayResultData, Totals } from "@/shared/api";
import { EVENT_TYPES } from "@/shared/constants";
import { cn } from "@/lib/utils";
import { AdminRequired } from "../admin-button";
import { EVENT_STYLE } from "../event-style";
import { CardSkeleton, EmptyState, ErrorPanel, Freshness, QueryBoundary } from "../states";
import { ToneBadge } from "../status-badge";

const TOTAL_ROWS: { key: keyof Totals; type?: (typeof EVENT_TYPES)[number]; label: string }[] = [
  { key: "pageViews", type: "page_view", label: EVENT_STYLE.page_view.plural },
  { key: "productClicks", type: "product_click", label: EVENT_STYLE.product_click.plural },
  { key: "cartAdditions", type: "add_to_cart", label: EVENT_STYLE.add_to_cart.plural },
  { key: "events", label: "All events" },
];

function TotalsList({ totals, label }: { totals: Totals; label: string }) {
  return (
    <dl className="grid gap-2" aria-label={label}>
      {TOTAL_ROWS.map((row) => (
        <div key={row.key} className={cn("flex items-baseline justify-between gap-3 text-sm", row.key === "events" && "border-t pt-2 font-medium")}>
          <dt className="flex items-center gap-2 text-muted-foreground">
            {row.type ? <span aria-hidden className="size-2.5 rounded-full" style={{ background: EVENT_STYLE[row.type].color }} /> : null}
            {row.label}
          </dt>
          <dd className="tabular-nums">{formatNumber(totals[row.key])}</dd>
        </div>
      ))}
    </dl>
  );
}

function ResultComparison({ result }: { result: ReplayResultData }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <section aria-labelledby="replay-result-heading" className="space-y-3 rounded-xl border p-4">
          <div>
            <h4 id="replay-result-heading" className="text-sm font-semibold">Replay result</h4>
            <p className="text-xs text-muted-foreground">Isolated run. Stored separately from live data.</p>
          </div>
          <TotalsList totals={result.totals} label="Replay totals" />
          <p className="text-xs text-muted-foreground tabular-nums">
            {formatNumber(result.sessions)} distinct {result.sessions === 1 ? "session" : "sessions"}
            {result.firstEventAt && result.lastEventAt ? ` · events from ${formatDateTime(result.firstEventAt)} to ${formatDateTime(result.lastEventAt)}` : ""}
          </p>
        </section>
        <section aria-labelledby="replay-live-heading" className="space-y-3 rounded-xl border bg-muted/30 p-4">
          <div>
            <h4 id="replay-live-heading" className="text-sm font-semibold">Live totals for the same window</h4>
            <p className="text-xs text-muted-foreground">Read now from the live results. A replay never changes these, but they can still grow when new events arrive.</p>
          </div>
          {result.liveTotalsForWindow ? (
            <TotalsList totals={result.liveTotalsForWindow} label="Live totals for the replayed window" />
          ) : (
            <p className="text-sm text-muted-foreground">Live totals for this window are not available.</p>
          )}
        </section>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section aria-label="Replay event types" className="space-y-2">
          <h4 className="text-sm font-semibold">Event types in the replay</h4>
          <ul className="space-y-1.5 text-sm">
            {EVENT_TYPES.map((type) => {
              const row = result.breakdown.find((item) => item.type === type);
              return (
                <li key={type} className="flex items-baseline justify-between gap-3">
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <span aria-hidden className="size-2.5 rounded-full" style={{ background: EVENT_STYLE[type].color }} />
                    {EVENT_STYLE[type].plural}
                  </span>
                  <span className="tabular-nums">
                    {formatNumber(row?.count ?? 0)} <span className="text-muted-foreground">({formatPercent(row?.share ?? null, 1)})</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
        <section aria-label="Replay top products" className="space-y-2">
          <h4 className="text-sm font-semibold">Top products in the replay</h4>
          {result.topProducts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No product activity in the replayed events.</p>
          ) : (
            <ol className="space-y-1.5 text-sm">
              {result.topProducts.map((product) => (
                <li key={product.productId} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-muted-foreground">{product.name}</span>
                  <span className="shrink-0 tabular-nums">
                    {formatNumber(product.clicks)} clicks · {formatNumber(product.cartAdds)} carts
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}

function JobDetail({ job, result }: { job: ReplayJobData; result: ReplayResultData | null }) {
  const status = describeReplayStatus(job.status);
  const percent = Math.round(job.progress * 100);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          Replay <span className="font-mono text-xs">{shortId(job.id)}</span>
        </h3>
        <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
      </div>

      <div className="space-y-1.5" aria-live="polite">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="text-muted-foreground">{job.status === "queued" ? "Waiting for a worker to claim the job" : "Progress by Kafka offsets"}</span>
          <span className="tabular-nums">{percent}%</span>
        </div>
        <Progress value={percent} aria-label="Replay progress" className="h-2" />
      </div>

      {job.partitions.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <caption className="sr-only">Replay position per partition</caption>
            <TableHeader className="bg-muted/40">
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">Partition</TableHead>
                <TableHead scope="col" className="text-right">From</TableHead>
                <TableHead scope="col" className="text-right">Position</TableHead>
                <TableHead scope="col" className="text-right">Until</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {job.partitions.map((partition) => (
                <TableRow key={partition.partition}>
                  <TableCell className="tabular-nums">{partition.partition}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatOffset(partition.startOffset)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatOffset(partition.position)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatOffset(partition.endOffset)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground tabular-nums">
        {formatNumber(job.processed)} stored · {formatNumber(job.rejected)} rejected · attempt {job.attempt} · created {formatDateTime(job.createdAt)}
        {job.finishedAt ? ` · finished ${formatDateTime(job.finishedAt)}` : ""} · results deleted {formatDateTime(job.expiresAt)}
      </p>

      {job.truncated ? (
        <Alert>
          <AlertTitle>Partial replay</AlertTitle>
          <AlertDescription className="text-foreground">
            Kafka retained more events than one replay reads, so the oldest were skipped. These statistics cover the newest events only.
          </AlertDescription>
        </Alert>
      ) : null}
      {job.error ? (
        <Alert variant="destructive">
          <AlertTitle>Replay failed</AlertTitle>
          <AlertDescription>{job.error}</AlertDescription>
        </Alert>
      ) : null}

      {result ? (
        <ResultComparison result={result} />
      ) : job.status === "completed" ? (
        <p className="text-sm text-muted-foreground">The replay finished without any events to report. Kafka may have had nothing retained.</p>
      ) : null}
    </div>
  );
}

/** Replay retained Kafka events into an isolated result set and compare it with the untouched live totals. */
export function ReplayPanel() {
  const { adminPost, isUnlocked } = useAdmin();
  const list = useReplays();
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const jobs = list.data?.items ?? [];
  const selectedId = chosenId ?? jobs[0]?.id ?? null;
  const detail = useReplayDetail(selectedId);
  // Only the data loaded for the selected job: never the previous job's while the new one loads.
  const detailData = detail.currentData;
  const activeJob = jobs.find((job) => isReplayActive(job.status));

  async function startReplay() {
    setStarting(true);
    setStartError(null);
    try {
      const job = await adminPost<ReplayJobData>("/api/replays", {});
      setChosenId(job.id);
      list.refresh();
    } catch (cause) {
      setStartError(cause instanceof ApiError ? `${cause.message} [${cause.code}]` : "The replay could not be started.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Replay retained events</CardTitle>
        <CardDescription>
          Re-read the events Kafka still holds into a separate result set to inspect them, without touching the live dashboard.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Runs in the background worker, using its own temporary consumer group.</li>
          <li>Reads only what Kafka still retains. Events that have expired cannot be replayed.</li>
          <li>Never resets the live consumers, changes live totals, regenerates alerts, or triggers anything external.</li>
        </ul>

        <AdminRequired id="replay-locked">Starting a replay needs the admin token.</AdminRequired>

        <div className="flex flex-wrap items-center gap-3">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" disabled={!isUnlocked || starting || Boolean(activeJob)}>
                <RotateCcw /> Start replay
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Start a replay?</AlertDialogTitle>
                <AlertDialogDescription>
                  A worker will read every event Kafka still retains and write the statistics into a separate result set. Live consumers, live totals and alerts are not affected. Expired events cannot be replayed, so the result only covers what is still in the topic.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void startReplay()}>Start replay</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {activeJob ? <span className="text-sm text-muted-foreground">A replay is in progress. Only one runs at a time.</span> : null}
          <Freshness query={list} className="ml-auto" />
        </div>

        {startError ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{startError}</AlertDescription>
          </Alert>
        ) : null}

        <QueryBoundary query={list} skeleton={<CardSkeleton rows={3} />} errorTitle="Couldn't load replays">
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState icon={<History aria-hidden />} title="No replays yet">
                Start one to see the statistics of everything Kafka currently retains.
              </EmptyState>
            ) : (
              <div className="grid gap-5 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
                <nav aria-label="Recent replays">
                  <ul className="space-y-2">
                    {data.items.map((job) => {
                      const jobStatus = describeReplayStatus(job.status);
                      const selected = job.id === selectedId;
                      return (
                        <li key={job.id}>
                          <button
                            type="button"
                            aria-pressed={selected}
                            onClick={() => setChosenId(job.id)}
                            className={cn(
                              "flex min-h-11 w-full flex-col gap-1.5 rounded-xl border p-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50",
                              selected && "border-primary bg-accent/50",
                            )}
                          >
                            <span className="flex items-center justify-between gap-2">
                              <span className="font-mono text-xs">{shortId(job.id)}</span>
                              <ToneBadge tone={jobStatus.tone}>{jobStatus.label}</ToneBadge>
                            </span>
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {formatDateTime(job.createdAt)} · {formatNumber(job.processed)} events
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </nav>
                <div className="min-w-0">
                  {detailData ? (
                    <>
                      {detail.error ? <ErrorPanel error={detail.error} onRetry={detail.refresh} title="Couldn't refresh this replay" className="mb-3" /> : null}
                      <JobDetail job={detailData.job} result={detailData.result} />
                    </>
                  ) : detail.error ? (
                    <ErrorPanel error={detail.error} onRetry={detail.refresh} title="Couldn't load this replay" />
                  ) : (
                    <CardSkeleton rows={5} />
                  )}
                </div>
              </div>
            )
          }
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}
