"use client";

import { useState } from "react";
import { CheckCircle2, Clock, Send } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAdmin } from "@/lib/client/admin-token";
import { ApiError } from "@/lib/client/api";
import { newId } from "@/lib/client/ids";
import { getTabSessionId } from "@/lib/client/session";
import { useEventConfirmation } from "@/lib/client/use-event-confirmation";
import { useNow } from "@/lib/client/use-now";
import { formatOffset, formatWhen, shortId } from "@/lib/format";
import type { IngestData } from "@/shared/api";
import { PAGES, PRODUCTS } from "@/shared/catalog";
import { EVENT_TYPES, EVENT_TYPE_LABELS, PRODUCT_EVENT_TYPES, TOPIC_NAME, type EventType } from "@/shared/constants";
import type { WebsiteEvent } from "@/shared/event-schema";
import { AdminRequired } from "../admin-button";
import { EVENT_STYLE } from "../event-style";

interface SentRecord {
  eventId: string;
  type: EventType;
  page: string;
  productId?: string;
  sentAt: number;
  partition: number | null;
  offset: string | null;
}

const MAX_RECORDS = 5;

/** Manual producer: one button per event type, each publishing a single event and showing Kafka's acknowledgement. */
export function SendEventsCard() {
  const { adminPost, isUnlocked } = useAdmin();
  const now = useNow();
  const [page, setPage] = useState<string>("/products");
  const [productId, setProductId] = useState<string>(PRODUCTS[0].id);
  const [sending, setSending] = useState<EventType | null>(null);
  const [records, setRecords] = useState<SentRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  // "Processed" is observed, not assumed: an event counts as processed once the analytics consumer
  // has stored it, and stays processed once seen.
  const { confirmed: processedIds, error: confirmationError } = useEventConfirmation(records.map((record) => record.eventId));

  async function send(type: EventType) {
    setSending(type);
    setError(null);
    try {
      // Everything that can throw, ids included, is inside the try so "Sending…" can never stick.
      const needsProduct = (PRODUCT_EVENT_TYPES as readonly EventType[]).includes(type);
      const event: WebsiteEvent = {
        eventId: newId(),
        type,
        timestamp: new Date().toISOString(),
        sessionId: getTabSessionId(),
        page,
        ...(needsProduct ? { productId } : {}),
        source: "playground",
      };
      const ack = await adminPost<IngestData>("/api/events", { events: [event] });
      const first = ack.acks[0];
      setRecords((current) =>
        [
          {
            eventId: event.eventId,
            type,
            page,
            productId: event.productId,
            sentAt: Date.now(),
            partition: first?.partition ?? null,
            offset: first?.baseOffset ?? null,
          },
          ...current,
        ].slice(0, MAX_RECORDS),
      );
    } catch (cause) {
      if (cause instanceof ApiError) {
        const detail = cause.issues?.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
        setError(`${cause.message}${detail ? ` (${detail})` : ""} [${cause.code}]`);
      } else {
        setError(`The event could not be sent${cause instanceof Error && cause.message ? `: ${cause.message}` : "."}`);
      }
    } finally {
      setSending(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Send events</CardTitle>
        <CardDescription>
          Publishes one event to the <code className="font-mono text-xs">{TOPIC_NAME}</code> topic. Messages are keyed by session id, so a session always lands in the same partition.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <AdminRequired id="send-events-locked">Sending events needs the admin token.</AdminRequired>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="lab-page">Page</FieldLabel>
            <Select value={page} onValueChange={setPage}>
              <SelectTrigger id="lab-page" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {PAGES.map((option) => (
                  <SelectItem key={option.path} value={option.path}>
                    {option.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="lab-product">Product (clicks and cart additions)</FieldLabel>
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger id="lab-product" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {PRODUCTS.map((product) => (
                  <SelectItem key={product.id} value={product.id}>
                    {product.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label="Event to send" aria-describedby={isUnlocked ? undefined : "send-events-locked"}>
          {EVENT_TYPES.map((type) => {
            const style = EVENT_STYLE[type];
            return (
              <Button
                key={type}
                type="button"
                variant="outline"
                disabled={!isUnlocked || sending !== null}
                onClick={() => void send(type)}
                className="w-full justify-start"
              >
                <style.icon style={{ color: style.color }} />
                {sending === type ? "Sending…" : EVENT_TYPE_LABELS[type]}
              </Button>
            );
          })}
        </div>

        {error ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div aria-live="polite">
          {records.length === 0 ? (
            <p className="text-sm text-muted-foreground">Acknowledgements from Kafka appear here.</p>
          ) : (
            <ul className="divide-y rounded-xl border">
              {records.map((record) => {
                const style = EVENT_STYLE[record.type];
                const processed = processedIds.has(record.eventId);
                return (
                  <li key={record.eventId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-sm">
                    <style.icon className="size-4 shrink-0" style={{ color: style.color }} aria-hidden />
                    <span className="font-medium">{style.label}</span>
                    <span className="font-mono text-xs text-muted-foreground">{shortId(record.eventId)}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatWhen(record.sentAt, now)}
                      {record.partition !== null ? ` · partition ${record.partition}` : ""}
                      {record.offset !== null ? ` · offset ${formatOffset(record.offset)}` : ""}
                    </span>
                    <span className="ml-auto">
                      {processed ? (
                        <Badge variant="success">
                          <CheckCircle2 aria-hidden /> Processed by analytics
                        </Badge>
                      ) : (
                        <Badge variant="secondary">
                          <Clock aria-hidden /> Accepted by Kafka — not yet processed
                        </Badge>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {confirmationError ? (
          <p className="text-xs text-warning" role="status">
            Couldn&apos;t check whether these events were processed: {confirmationError.message} Retrying automatically.
          </p>
        ) : null}
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Send className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Accepted means Kafka confirmed the write. Processed means the analytics consumer has stored the event, so it is visible in Live events and the charts.
        </p>
      </CardContent>
    </Card>
  );
}
