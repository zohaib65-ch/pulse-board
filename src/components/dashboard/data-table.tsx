"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown, Info } from "lucide-react";
import { rowSortingFeature, tableFeatures, useTable, type ColumnDef, type RowData, type SortingState } from "@tanstack/react-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Thin shadcn Data Table on TanStack Table v9. All sorting, paging and filtering happens on the
 * server, so the table runs in manual mode: it renders the rows it is given and reports header
 * clicks through `onSortingChange`.
 */
/** Optional per-column presentation hints, set through `columnDef.meta`. */
interface ColumnHints {
  align?: "right";
  /** Definition shown in a tooltip next to the header (also keep it visible elsewhere for touch users). */
  help?: string;
}

function HelpTip({ label, text }: { label: string; text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${text}`}
          className="inline-grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 touch:size-11"
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{text}</TooltipContent>
    </Tooltip>
  );
}

export const dataTableFeatures = tableFeatures({ rowSortingFeature });
export type DataTableFeatures = typeof dataTableFeatures;

interface DataTableProps<TData extends RowData> {
  columns: ColumnDef<DataTableFeatures, TData>[];
  data: TData[];
  getRowId: (row: TData) => string;
  /** Accessible name of the table. */
  caption: string;
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  /** Mouse convenience; keyboard users activate the button rendered inside the first cell. */
  onRowClick?: (row: TData) => void;
  className?: string;
}

export function DataTable<TData extends RowData>({
  columns,
  data,
  getRowId,
  caption,
  sorting = [],
  onSortingChange,
  onRowClick,
  className,
}: DataTableProps<TData>) {
  const table = useTable({
    features: dataTableFeatures,
    columns,
    data,
    getRowId,
    manualSorting: true,
    enableSortingRemoval: false,
    state: { sorting },
    onSortingChange: (updater) => onSortingChange?.(typeof updater === "function" ? updater(sorting) : updater),
  });

  return (
    <div className={cn("overflow-hidden rounded-xl border", className)}>
      <Table>
        <caption className="sr-only">{caption}</caption>
        <TableHeader className="bg-muted/40">
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id} className="hover:bg-transparent">
              {headerGroup.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                const canSort = header.column.getCanSort();
                const hints = (header.column.columnDef.meta ?? {}) as ColumnHints;
                const align = hints.align;
                return (
                  <TableHead
                    key={header.id}
                    scope="col"
                    aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : canSort ? "none" : undefined}
                    className={cn("h-11 whitespace-nowrap", align === "right" && "text-right")}
                  >
                    {header.isPlaceholder ? null : (
                      <span className={cn("inline-flex items-center gap-1", align === "right" && "flex-row-reverse")}>
                        {canSort ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className={cn(
                              "-mx-2 inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 touch:min-h-11",
                              align === "right" && "flex-row-reverse",
                            )}
                          >
                            <table.FlexRender header={header} />
                            {sorted === "asc" ? (
                              <ArrowUp className="size-3.5" aria-hidden />
                            ) : sorted === "desc" ? (
                              <ArrowDown className="size-3.5" aria-hidden />
                            ) : (
                              <ChevronsUpDown className="size-3.5 text-muted-foreground" aria-hidden />
                            )}
                          </button>
                        ) : (
                          <table.FlexRender header={header} />
                        )}
                        {hints.help ? <HelpTip label={`About ${String(header.column.columnDef.header ?? header.column.id)}`} text={hints.help} /> : null}
                      </span>
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id} onClick={onRowClick ? () => onRowClick(row.original) : undefined} className={cn(onRowClick && "cursor-pointer")}>
              {row.getAllCells().map((cell) => {
                const align = ((cell.column.columnDef.meta ?? {}) as ColumnHints).align;
                return (
                  <TableCell key={cell.id} className={cn("py-2.5 tabular-nums", align === "right" && "text-right")}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
