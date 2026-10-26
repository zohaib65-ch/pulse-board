"use client";

import type {
  AlertsData,
  EventsData,
  OverviewData,
  ProductSortKey,
  ProductsData,
  ReplayDetailData,
  ReplayListData,
  StatusData,
} from "@/shared/api";
import type { EventType, RangeKey } from "@/shared/constants";
import { POLLING } from "@/shared/constants";
import { apiGet, queryString } from "./api";
import { isReplayActive } from "./status";
import { usePolling } from "./use-polling";

/** One hook per read endpoint. All share the same polling behaviour (see `usePolling`). */

export function useOverview(range: RangeKey) {
  return usePolling<OverviewData>({
    key: `overview:${range}`,
    fetcher: (signal) => apiGet(`/api/metrics/overview${queryString({ range })}`, signal),
  });
}

export interface EventsQuery {
  range: RangeKey;
  type?: EventType | null;
  page?: string | null;
  productId?: string | null;
  cursor?: string | null;
  limit?: number;
  /**
   * Direct lookup of up to QUERY_LIMITS.eventsLookupMaxIds event ids (newest first is the caller's
   * order). The server ignores range, filters, cursor and limit for these and returns the stored
   * events among them; ids that are not stored yet are simply absent.
   */
  ids?: readonly string[];
}

/** Query string for GET /api/events. */
export function eventsQueryString(query: EventsQuery): string {
  return queryString({
    range: query.range,
    type: query.type,
    page: query.page,
    productId: query.productId,
    cursor: query.cursor,
    limit: query.limit,
    ids: query.ids?.join(","),
  });
}

export function useEvents(query: EventsQuery, options: { paused?: boolean; intervalMs?: number } = {}) {
  const qs = eventsQueryString(query);
  return usePolling<EventsData>({
    key: `events${qs}`,
    fetcher: (signal) => apiGet(`/api/events${qs}`, signal),
    paused: options.paused,
    intervalMs: options.intervalMs,
  });
}

export interface ProductsQuery {
  range: RangeKey;
  q: string;
  sort: ProductSortKey;
  order: "asc" | "desc";
  page: number;
  pageSize: number;
}

export function useProducts(query: ProductsQuery) {
  const qs = queryString({ ...query });
  return usePolling<ProductsData>({
    key: `products${qs}`,
    fetcher: (signal) => apiGet(`/api/products${qs}`, signal),
  });
}

export function useAlerts(limit: number) {
  const qs = queryString({ limit });
  return usePolling<AlertsData>({
    key: `alerts${qs}`,
    fetcher: (signal) => apiGet(`/api/alerts${qs}`, signal),
  });
}

export function useStatus() {
  return usePolling<StatusData>({
    key: "status",
    fetcher: (signal) => apiGet("/api/status", signal),
  });
}

const REPLAY_FAST_POLL_MS = 2500;

/** Replays are polled faster while a job is queued or running. */
export function useReplays() {
  return usePolling<ReplayListData>({
    key: "replays",
    fetcher: (signal) => apiGet("/api/replays", signal),
    intervalMs: (data) => (data?.items.some((job) => isReplayActive(job.status)) ? REPLAY_FAST_POLL_MS : POLLING.intervalMs),
  });
}

/** `id` null means nothing is selected: no request is made and the result stays empty. */
export function useReplayDetail(id: string | null) {
  return usePolling<ReplayDetailData | null>({
    key: `replay:${id ?? "none"}`,
    fetcher: (signal) => (id ? apiGet<ReplayDetailData>(`/api/replays/${encodeURIComponent(id)}`, signal) : Promise.resolve(null)),
    intervalMs: (data) => (data && isReplayActive(data.job.status) ? REPLAY_FAST_POLL_MS : POLLING.intervalMs),
  });
}
