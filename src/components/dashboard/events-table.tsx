"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, shortId } from "@/lib/format";
import { productName } from "@/shared/catalog";
import type { EventItem } from "@/shared/api";
import { DataTable, type DataTableFeatures } from "./data-table";
import { EVENT_STYLE } from "./event-style";
import { createColumnHelper } from "@tanstack/react-table";

const columnHelper = createColumnHelper<DataTableFeatures, EventItem>();

export function TypeBadge({ type }: { type: EventItem["type"] }) {
  const style = EVENT_STYLE[type];
  return (
    <Badge variant="outline" className="gap-1.5">
      <style.icon aria-hidden style={{ color: style.color }} />
      {style.label}
    </Badge>
  );
}

/**
 * Events as a table from lg up and as tappable cards below it (the sidebar leaves less room at tablet widths). Both open the details dialog; the
 * first table cell and every card are real buttons, so keyboard and screen-reader users can too.
 */
export function EventsTable({ items, onSelect }: { items: EventItem[]; onSelect: (item: EventItem) => void }) {
  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor("timestamp", {
          header: "Time",
          enableSorting: false,
          cell: (info) => (
            <button
              type="button"
              aria-label={`Open details for ${EVENT_STYLE[info.row.original.type].label} at ${formatDateTime(info.getValue())}`}
              className="-mx-2 rounded-md px-2 py-1 text-left font-medium outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {formatDateTime(info.getValue())}
            </button>
          ),
        }),
        columnHelper.accessor("type", {
          header: "Event",
          enableSorting: false,
          cell: (info) => <TypeBadge type={info.getValue()} />,
        }),
        columnHelper.accessor("page", {
          header: "Page",
          enableSorting: false,
          cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
        }),
        columnHelper.accessor((row) => row.productId, {
          id: "product",
          header: "Product",
          enableSorting: false,
          cell: (info) => {
            const id = info.getValue();
            return id ? productName(id) : <span className="text-muted-foreground">—</span>;
          },
        }),
        columnHelper.accessor("sessionId", {
          header: "Session",
          enableSorting: false,
          cell: (info) => <span className="font-mono text-xs">{shortId(info.getValue())}</span>,
        }),
      ]),
    [],
  );

  return (
    <>
      <div className="hidden lg:block">
        <DataTable columns={columns} data={items} getRowId={(row) => row.eventId} caption="Recent events, newest first" onRowClick={onSelect} />
      </div>
      <ul className="grid gap-2 lg:hidden" aria-label="Recent events, newest first">
        {items.map((item) => (
          <li key={item.eventId}>
            <button
              type="button"
              onClick={() => onSelect(item)}
              aria-label={`Open details for ${EVENT_STYLE[item.type].label} at ${formatDateTime(item.timestamp)}`}
              className="flex min-h-11 w-full flex-col gap-2 rounded-xl border bg-card p-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="flex items-center justify-between gap-2">
                <TypeBadge type={item.type} />
                <span className="text-xs text-muted-foreground tabular-nums">{formatDateTime(item.timestamp)}</span>
              </span>
              <span className="font-mono text-xs break-all">{item.page}</span>
              <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">{item.productId ? productName(item.productId) : "No product"}</span>
                <span className="font-mono">{shortId(item.sessionId)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
