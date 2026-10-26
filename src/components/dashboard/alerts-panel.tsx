"use client";

import Link from "next/link";
import { ArrowRight, BellRing, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatNumber, shortId } from "@/lib/format";
import type { PollingResult } from "@/lib/client/use-polling";
import type { AlertsData } from "@/shared/api";
import { SPIKE_RULE } from "@/shared/constants";
import { CardSkeleton, EmptyState, QueryBoundary } from "./states";

/** Recent in-app alerts created by the alerts consumer group. */
export function AlertsPanel({ query, notice = true }: { query: PollingResult<AlertsData>; notice?: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent alerts</CardTitle>
        <CardDescription>
          Raised when one session sends more than {SPIKE_RULE.eventsPerSessionPerWindow} events in a minute.
        </CardDescription>
        <CardAction>
          <Button asChild variant="ghost" size="sm">
            <Link href="/lab">
              Kafka Lab <ArrowRight />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <QueryBoundary query={query} skeleton={<CardSkeleton rows={3} />} errorTitle="Couldn't load alerts" notice={notice}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState icon={<ShieldCheck aria-hidden />} title="No alerts">
                Nothing unusual has been detected. The spike demo in the Kafka Lab raises one.
              </EmptyState>
            ) : (
              <ul className="divide-y">
                {data.items.map((alert) => (
                  <li key={alert.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                    <BellRing className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="warning">Session spike</Badge>
                        <span className="text-xs text-muted-foreground tabular-nums">{formatDateTime(alert.createdAt)}</span>
                      </div>
                      <p className="text-sm">
                        Session <span className="font-mono text-xs">{shortId(alert.sessionId)}</span> sent more than{" "}
                        <span className="tabular-nums">{formatNumber(alert.threshold)}</span> events in one minute (
                        <span className="tabular-nums">{formatNumber(alert.count)}</span> counted when the alert fired).
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )
          }
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}
