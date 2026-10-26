"use client";

import Link from "next/link";
import { AlertCircle, AlertTriangle, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelative, formatWhen } from "@/lib/format";
import type { ApiError } from "@/lib/client/api";
import type { PollingResult } from "@/lib/client/use-polling";
import { useNow } from "@/lib/client/use-now";
import { cn } from "@/lib/utils";

/** Shown when a request fails and there is nothing earlier to fall back on. */
export function ErrorPanel({
  error,
  onRetry,
  title = "Couldn't load this data",
  className,
}: {
  error: ApiError;
  onRetry?: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <Alert variant="destructive" className={className}>
      <AlertCircle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>
          {error.message}
          {error.code !== "network" && error.code !== "bad_response" ? <span className="ml-1 font-mono text-xs">({error.code})</span> : null}
        </p>
        {onRetry ? (
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetry}>
            <RefreshCw /> Retry
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** One-line notice above content that is still on screen after a failed refresh. */
export function StaleNotice({ error, lastUpdatedAt, onRetry }: { error: ApiError; lastUpdatedAt: number | null; onRetry: () => void }) {
  const now = useNow();
  return (
    <div
      role="status"
      className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
    >
      <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0 flex-1 text-foreground">
        Showing data from {formatWhen(lastUpdatedAt, now)}. The latest refresh failed: {error.message}
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
        <RefreshCw /> Retry
      </Button>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center", className)}>
      {icon ? <div className="text-muted-foreground [&_svg]:size-6">{icon}</div> : null}
      <p className="text-sm font-medium">{title}</p>
      {children ? <div className="max-w-md text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}

/** Link to the Kafka Lab, used in empty states. */
export function LabLink({ children = "Open the Kafka Lab" }: { children?: React.ReactNode }) {
  return (
    <Link href="/lab" className="font-medium text-primary underline underline-offset-4">
      {children}
    </Link>
  );
}

/**
 * Standard handling of a polled query:
 * - skeleton on first load;
 * - the content, with a stale notice if the latest refresh of the SAME request failed;
 * - an error panel when the current request has failed and there is nothing for it to show;
 * - while a changed request (new filter, next page) loads, the previous content dimmed.
 *
 * Pass `notice={false}` when the page shows one combined stale notice itself.
 */
export function QueryBoundary<T>({
  query,
  skeleton,
  errorTitle,
  notice = true,
  children,
}: {
  query: PollingResult<T>;
  skeleton: React.ReactNode;
  errorTitle?: string;
  notice?: boolean;
  children: (data: T) => React.ReactNode;
}) {
  if (query.currentData !== null) {
    return (
      <>
        {notice && query.error ? <StaleNotice error={query.error} lastUpdatedAt={query.lastUpdatedAt} onRetry={query.refresh} /> : null}
        {children(query.currentData)}
      </>
    );
  }
  if (query.error) return <ErrorPanel error={query.error} onRetry={query.refresh} title={errorTitle} />;
  if (query.data !== null) {
    return (
      <div aria-busy className="opacity-60 transition-opacity">
        {children(query.data)}
      </div>
    );
  }
  return <>{skeleton}</>;
}

/** "Updated 14:03:05" with a stale badge and a manual refresh button. */
export function Freshness({
  query,
  className,
}: {
  query: Pick<PollingResult<unknown>, "lastUpdatedAt" | "isRefreshing" | "isStale" | "refresh">;
  className?: string;
}) {
  const now = useNow();
  return (
    <div className={cn("flex items-center gap-2 text-sm text-muted-foreground", className)}>
      <span className="tabular-nums" aria-live="off">
        {query.lastUpdatedAt ? (
          <>
            Updated {formatWhen(query.lastUpdatedAt, now)}
            {query.isStale && now > 0 ? <span className="text-foreground"> · {formatRelative(query.lastUpdatedAt, now)}</span> : null}
          </>
        ) : (
          "Loading…"
        )}
      </span>
      {query.isStale ? (
        <Badge variant="warning">
          <AlertTriangle aria-hidden /> Stale
        </Badge>
      ) : null}
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Refresh now" onClick={query.refresh} disabled={query.isRefreshing}>
        <RefreshCw className={cn(query.isRefreshing && "animate-spin")} />
      </Button>
    </div>
  );
}

export function CardSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-3", className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-6 w-full" />
      ))}
    </div>
  );
}
