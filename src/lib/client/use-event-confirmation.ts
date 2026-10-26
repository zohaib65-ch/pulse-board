"use client";

import { useState, useSyncExternalStore } from "react";
import type { EventsData } from "@/shared/api";
import { DEFAULT_RANGE, QUERY_LIMITS } from "@/shared/constants";
import { apiGet } from "./api";
import { eventsQueryString } from "./hooks";
import { IdLatch } from "./id-latch";
import type { ApiError } from "./api";
import { usePolling } from "./use-polling";

/** While any sent event is unconfirmed, ask again this often. */
export const CONFIRMATION_POLL_MS = 2000;

/**
 * Confirms which of the events this tab sent have been stored by the analytics consumer.
 *
 * It looks up ONLY the ids still unconfirmed (newest first, at most one lookup's worth) by primary
 * key, so the answer does not depend on a time window or on how many newer events exist. Polling
 * stops when nothing is pending, and confirmation is a one-way latch per id.
 *
 * @param sentIds ids of events the server acknowledged, newest first
 */
export function useEventConfirmation(sentIds: readonly string[]): { confirmed: ReadonlySet<string>; error: ApiError | null } {
  const [latch] = useState(() => new IdLatch());
  const confirmed = useSyncExternalStore(latch.subscribe, latch.getSnapshot, latch.getSnapshot);

  // The request key follows the list of sent ids, not the pending subset, so confirming one id
  // does not trigger an extra request: pending ids are worked out when each request is made.
  const lookupWindow = sentIds.slice(0, QUERY_LIMITS.eventsLookupMaxIds);
  const hasPending = lookupWindow.some((id) => !confirmed.has(id));

  const query = usePolling<EventsData | null>({
    key: `confirm:${lookupWindow.join(",")}`,
    fetcher: async (signal) => {
      const pending = lookupWindow.filter((id) => !latch.has(id));
      if (pending.length === 0) return null;
      const data = await apiGet<EventsData>(`/api/events${eventsQueryString({ range: DEFAULT_RANGE, ids: pending })}`, signal);
      latch.add(data.items.map((item) => item.eventId));
      return data;
    },
    intervalMs: CONFIRMATION_POLL_MS,
    paused: !hasPending,
  });

  return { confirmed, error: query.error };
}
