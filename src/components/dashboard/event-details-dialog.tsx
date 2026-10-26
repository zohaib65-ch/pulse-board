"use client";

import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDateTime, formatOffset } from "@/lib/format";
import { productName } from "@/shared/catalog";
import type { EventItem } from "@/shared/api";
import { EVENT_STYLE } from "./event-style";

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[9rem_1fr] sm:gap-4">
      <dt className="text-xs font-medium text-muted-foreground sm:pt-0.5 sm:text-sm">{label}</dt>
      <dd className="min-w-0 text-sm break-all">{children}</dd>
    </div>
  );
}

/** Every stored field of one event, including the Kafka coordinates it was read from. */
export function EventDetailsDialog({ event, onOpenChange }: { event: EventItem | null; onOpenChange: (open: boolean) => void }) {
  const style = event ? EVENT_STYLE[event.type] : null;
  return (
    <Dialog open={event !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Event details</DialogTitle>
          <DialogDescription>As stored by the analytics consumer, with the Kafka partition and offset it came from.</DialogDescription>
        </DialogHeader>
        {event && style ? (
          <dl className="grid gap-3">
            <Detail label="Type">
              <Badge variant="outline">
                <style.icon aria-hidden style={{ color: style.color }} /> {style.label}
              </Badge>
            </Detail>
            <Detail label="Event time">
              <span className="tabular-nums">{formatDateTime(event.timestamp)}</span>
              <span className="mt-0.5 block font-mono text-xs text-muted-foreground">{event.timestamp}</span>
            </Detail>
            <Detail label="Event ID">
              <span className="font-mono text-xs">{event.eventId}</span>
            </Detail>
            <Detail label="Session ID">
              <span className="font-mono text-xs">{event.sessionId}</span>
            </Detail>
            <Detail label="Page">
              <span className="font-mono text-xs">{event.page}</span>
            </Detail>
            <Detail label="Product">
              {event.productId ? (
                <>
                  {productName(event.productId)} <span className="font-mono text-xs text-muted-foreground">({event.productId})</span>
                </>
              ) : (
                "—"
              )}
            </Detail>
            <Detail label="Source">{event.source}</Detail>
            <Detail label="Kafka position">
              <span className="tabular-nums">
                partition {event.kafka.partition}, offset {formatOffset(event.kafka.offset)}
              </span>
            </Detail>
            <Detail label="Processed at">
              <span className="tabular-nums">{formatDateTime(event.processedAt)}</span>
              <span className="mt-0.5 block font-mono text-xs text-muted-foreground">{event.processedAt}</span>
            </Detail>
          </dl>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
