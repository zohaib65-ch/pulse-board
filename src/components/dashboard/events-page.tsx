"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Info, Pause, Play, Radio } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useEvents } from "@/lib/client/hooks";
import { useRange } from "@/lib/client/range-provider";
import { useKeyedState } from "@/lib/client/use-keyed-state";
import { useNow } from "@/lib/client/use-now";
import { formatWhen } from "@/lib/format";
import { PAGES, PRODUCTS } from "@/shared/catalog";
import { EVENT_TYPES, EVENT_TYPE_LABELS, QUERY_LIMITS, RETENTION, type EventType } from "@/shared/constants";
import type { EventItem } from "@/shared/api";
import { EventDetailsDialog } from "./event-details-dialog";
import { EventsTable } from "./events-table";
import { PageHeader } from "./page-header";
import { RangeSelect } from "./range-select";
import { EmptyState, Freshness, LabLink, QueryBoundary } from "./states";

const ALL = "all";

interface Filters {
  type: EventType | typeof ALL;
  page: string;
  productId: string;
}

/** Cursor stack: entry `i` is the cursor that loads page `i + 1`. It starts over whenever the filters or range change. */
interface Pager {
  cursors: (string | null)[];
  index: number;
}

const FIRST_PAGE: Pager = { cursors: [null], index: 0 };

export function EventsPage() {
  const { range } = useRange();
  const now = useNow();
  const [filters, setFilters] = useState<Filters>({ type: ALL, page: ALL, productId: ALL });
  const [displayPaused, setDisplayPaused] = useState(false);
  const [selected, setSelected] = useState<EventItem | null>(null);

  const filterKey = `${range}|${filters.type}|${filters.page}|${filters.productId}`;
  const [pager, setPager] = useKeyedState<Pager>(filterKey, FIRST_PAGE);

  const query = useEvents(
    {
      range,
      type: filters.type === ALL ? null : filters.type,
      page: filters.page === ALL ? null : filters.page,
      productId: filters.productId === ALL ? null : filters.productId,
      cursor: pager.cursors[pager.index] ?? null,
      limit: QUERY_LIMITS.eventsDefaultPageSize,
    },
    { paused: displayPaused },
  );

  const filtersActive = filters.type !== ALL || filters.page !== ALL || filters.productId !== ALL;
  const updateFilter = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }));

  // The pager only acts on data that belongs to the page being shown. While another page or filter
  // is still loading, `data` is the previous request's and its nextCursor would be wrong.
  const loadingAnother = query.isPlaceholderData;
  const goOlder = (nextCursor: string) => {
    if (loadingAnother) return;
    const cursors = pager.cursors.slice(0, pager.index + 1);
    cursors.push(nextCursor);
    setPager({ cursors, index: pager.index + 1 });
  };
  const goNewer = () => {
    if (loadingAnother) return;
    setPager({ ...pager, index: Math.max(0, pager.index - 1) });
  };

  return (
    <>
      <PageHeader
        title="Live events"
        description="Events stored by the analytics consumer, newest first. Filters run on the server."
        actions={
          <>
            <RangeSelect />
            <Freshness query={query} />
          </>
        }
      />

      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[repeat(3,minmax(0,1fr))_auto] xl:items-end">
          <Field>
            <FieldLabel htmlFor="filter-type">Event type</FieldLabel>
            <Select value={filters.type} onValueChange={(value) => updateFilter({ type: value as Filters["type"] })}>
              <SelectTrigger id="filter-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value={ALL}>All event types</SelectItem>
                {EVENT_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {EVENT_TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="filter-page">Page</FieldLabel>
            <Select value={filters.page} onValueChange={(value) => updateFilter({ page: value })}>
              <SelectTrigger id="filter-page" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value={ALL}>All pages</SelectItem>
                {PAGES.map((page) => (
                  <SelectItem key={page.path} value={page.path}>
                    {page.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="filter-product">Product</FieldLabel>
            <Select value={filters.productId} onValueChange={(value) => updateFilter({ productId: value })}>
              <SelectTrigger id="filter-product" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value={ALL}>All products</SelectItem>
                {PRODUCTS.map((product) => (
                  <SelectItem key={product.id} value={product.id}>
                    {product.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button
            type="button"
            variant={displayPaused ? "default" : "outline"}
            aria-pressed={displayPaused}
            onClick={() => setDisplayPaused((paused) => !paused)}
            className="w-full sm:col-span-2 xl:col-span-1 xl:w-auto"
          >
            {displayPaused ? <Play /> : <Pause />}
            {displayPaused ? "Resume display" : "Pause display"}
          </Button>
        </div>

        {displayPaused ? (
          <Alert>
            <Info />
            <AlertDescription className="text-foreground">
              Display paused — this does not pause any Kafka consumer. Pause consumers in the <Link href="/lab" className="font-medium text-primary underline underline-offset-4">Kafka Lab</Link>.
              {query.lastUpdatedAt ? <span className="text-muted-foreground"> The list is frozen at {formatWhen(query.lastUpdatedAt, now)}.</span> : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <QueryBoundary
          query={query}
          errorTitle="Couldn't load events"
          skeleton={
            <div className="space-y-2" role="status" aria-label="Loading events">
              {Array.from({ length: 8 }, (_, index) => (
                <Skeleton key={index} className="h-11 w-full" />
              ))}
            </div>
          }
        >
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState icon={<Radio aria-hidden />} title={filtersActive || pager.index > 0 ? "No events match" : "No events in this range yet"}>
                {filtersActive || pager.index > 0 ? (
                  <>
                    <span className="block">
                      {filtersActive ? "Nothing matches these filters in the selected range." : "This page is past the oldest retained event."}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() => {
                        setFilters({ type: ALL, page: ALL, productId: ALL });
                        setPager(FIRST_PAGE);
                      }}
                    >
                      {filtersActive ? "Clear filters" : "Back to newest"}
                    </Button>
                  </>
                ) : (
                  <>
                    Events appear once the analytics consumer has processed them. Send some from the <LabLink>Kafka Lab</LabLink>.
                  </>
                )}
              </EmptyState>
            ) : (
              <>
                <EventsTable items={data.items} onSelect={setSelected} />
                <nav aria-label="Events pagination" className="flex flex-wrap items-center justify-between gap-3 pt-2">
                  <p className="text-sm text-muted-foreground tabular-nums">
                    Page {pager.index + 1} · up to {data.limit} per page · retained for {RETENTION.historyHours} hours
                  </p>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" onClick={goNewer} disabled={pager.index === 0 || loadingAnother}>
                      <ChevronLeft /> Newer
                    </Button>
                    <Button type="button" variant="outline" onClick={() => data.nextCursor && goOlder(data.nextCursor)} disabled={!data.nextCursor || loadingAnother}>
                      Older <ChevronRight />
                    </Button>
                  </div>
                </nav>
              </>
            )
          }
        </QueryBoundary>
      </div>

      <EventDetailsDialog event={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </>
  );
}
