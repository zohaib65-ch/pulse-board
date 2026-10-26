import type { Db, Filter } from "mongodb";
import { z } from "zod";
import { QUERY_LIMITS, type EventType, type RangeKey } from "@/shared/constants";
import type { EventItem, EventsData } from "@/shared/api";
import { rangeWindow } from "@/shared/time";
import { collections, type EventDoc } from "../collections";
import { ApiError } from "../errors";

export interface EventsQuery {
  range: RangeKey;
  type?: EventType;
  page?: string;
  productId?: string;
  cursor?: string;
  limit: number;
  /** Direct lookup by eventId (at most QUERY_LIMITS.eventsLookupMaxIds). Ignores range and pagination. */
  ids?: string[];
}

const cursorSchema = z.object({ t: z.number().int(), id: z.string().max(64) });

export function encodeCursor(timestamp: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: timestamp.getTime(), id })).toString("base64url");
}

function decodeCursor(cursor: string): { t: number; id: string } {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new ApiError(400, "invalid_request", "The pagination cursor is not valid.", {
      issues: [{ path: "cursor", message: "invalid cursor" }],
    });
  }
}

function toItem(doc: EventDoc): EventItem {
  return {
    eventId: doc._id,
    type: doc.type,
    timestamp: doc.timestamp.toISOString(),
    sessionId: doc.sessionId,
    page: doc.page,
    productId: doc.productId ?? null,
    source: doc.source,
    kafka: { partition: doc.partition, offset: doc.offset },
    processedAt: doc.processedAt.toISOString(),
  };
}

/** Newest-first keyset pagination: bounded by `limit`, served from the (timestamp, _id) indexes. */
export async function getEvents(db: Db, query: EventsQuery, now: Date = new Date()): Promise<EventsData> {
  const { fromMs } = rangeWindow(query.range, now.getTime());
  if (query.ids) {
    // Point lookup by primary key: bounded by the id list, independent of the time window.
    const found = await collections(db)
      .events.find({ _id: { $in: query.ids } })
      .sort({ timestamp: -1, _id: -1 })
      .maxTimeMS(QUERY_LIMITS.maxTimeMs)
      .toArray();
    return { range: query.range, generatedAt: now.toISOString(), items: found.map(toItem), nextCursor: null, limit: query.ids.length };
  }
  const conditions: Filter<EventDoc>[] = [{ timestamp: { $gte: new Date(fromMs) } }];
  if (query.type) conditions.push({ type: query.type });
  if (query.page) conditions.push({ page: query.page });
  if (query.productId) conditions.push({ productId: query.productId });
  if (query.cursor) {
    const { t, id } = decodeCursor(query.cursor);
    const at = new Date(t);
    conditions.push({ $or: [{ timestamp: { $lt: at } }, { timestamp: at, _id: { $lt: id } }] });
  }

  const docs = await collections(db)
    .events.find({ $and: conditions })
    .sort({ timestamp: -1, _id: -1 })
    .limit(query.limit + 1)
    .maxTimeMS(QUERY_LIMITS.maxTimeMs)
    .toArray();

  const hasMore = docs.length > query.limit;
  const pageDocs = hasMore ? docs.slice(0, query.limit) : docs;
  const last = pageDocs[pageDocs.length - 1];

  return {
    range: query.range,
    generatedAt: now.toISOString(),
    items: pageDocs.map(toItem),
    nextCursor: hasMore && last ? encodeCursor(last.timestamp, last._id) : null,
    limit: query.limit,
  };
}
