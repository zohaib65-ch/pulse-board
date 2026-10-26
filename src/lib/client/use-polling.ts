"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { POLLING } from "@/shared/constants";
import type { ApiError } from "./api";
import { Poller } from "./poller";
import { useNow } from "./use-now";

export interface UsePollingOptions<T> {
  /** Identity of the request (endpoint + params). A new key reloads immediately. */
  key: string;
  fetcher: (signal: AbortSignal) => Promise<T>;
  /** Fixed delay, or a function of the latest data (e.g. poll faster while a job is running). */
  intervalMs?: number | ((data: T | null) => number);
  /** Freeze interval refreshes (e.g. the Live Events "Pause display" toggle). */
  paused?: boolean;
}

export interface PollingResult<T> {
  /** Latest payload. May belong to an earlier key; see `isPlaceholderData` and `currentData`. */
  data: T | null;
  /** `data`, but only when it was loaded for the current key (never placeholder data). */
  currentData: T | null;
  error: ApiError | null;
  /** First load: nothing to show yet. */
  isLoading: boolean;
  /** A request is in flight (initial or refresh). */
  isRefreshing: boolean;
  /** `data` belongs to an earlier key (filters just changed) and is being replaced. */
  isPlaceholderData: boolean;
  lastUpdatedAt: number | null;
  /** Older than POLLING.staleAfterMs, or the latest refresh failed while old data is on screen. */
  isStale: boolean;
  refresh: () => void;
}

export function usePolling<T>({ key, fetcher, intervalMs = POLLING.intervalMs, paused = false }: UsePollingOptions<T>): PollingResult<T> {
  const [poller] = useState(() => new Poller<T>());
  const state = useSyncExternalStore(poller.subscribe, poller.getSnapshot, poller.getSnapshot);
  const now = useNow();

  const interval = typeof intervalMs === "function" ? intervalMs(state.data) : intervalMs;

  useEffect(() => {
    poller.configure({ key, fetcher, intervalMs: interval, paused });
  });

  useEffect(() => {
    poller.start();
    return () => poller.stop();
  }, [poller]);

  const hasData = state.data !== null;
  // An error only counts for the request that produced it.
  const error = state.errorKey === key ? state.error : null;
  const isPlaceholderData = hasData && state.dataKey !== key;
  const isStale =
    hasData &&
    (error !== null || (now > 0 && state.lastUpdatedAt !== null && !paused && now - state.lastUpdatedAt > POLLING.staleAfterMs));

  return {
    data: state.data,
    currentData: hasData && !isPlaceholderData ? state.data : null,
    error,
    isLoading: !hasData && error === null,
    isRefreshing: state.fetching,
    isPlaceholderData,
    lastUpdatedAt: state.lastUpdatedAt,
    isStale,
    refresh: poller.refresh,
  };
}
