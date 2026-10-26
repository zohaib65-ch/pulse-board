import { POLLING } from "@/shared/constants";
import { ApiError } from "./api";

export interface PollState<T> {
  /** Latest successful payload (possibly for an earlier key; see `dataKey`). */
  data: T | null;
  /** The key `data` was loaded for. */
  dataKey: string | null;
  error: ApiError | null;
  /** The key whose request produced `error`, so an error is never shown for a different request. */
  errorKey: string | null;
  /** Wall-clock time of the last successful load. */
  lastUpdatedAt: number | null;
  /** A request is currently in flight. */
  fetching: boolean;
  /** Consecutive failed refreshes; drives the backoff. */
  failures: number;
}

export interface PollConfig<T> {
  /** Identity of the request. Changing it aborts any in-flight request and reloads immediately. */
  key: string;
  fetcher: (signal: AbortSignal) => Promise<T>;
  intervalMs: number;
  /**
   * When true, the interval refresh stops (the display is frozen). A key change or `refresh()`
   * still loads once, so filters keep working while updates are paused.
   */
  paused: boolean;
}

const INITIAL: PollState<never> = {
  data: null,
  dataKey: null,
  error: null,
  errorKey: null,
  lastUpdatedAt: null,
  fetching: false,
  failures: 0,
};

/** Delay before the next refresh: the normal interval, or exponential backoff after errors. */
export function nextDelayMs(failures: number, intervalMs: number, retryAfterSeconds?: number): number {
  if (failures <= 0) return intervalMs;
  const backoff = Math.min(POLLING.backoffBaseMs * 2 ** (failures - 1), POLLING.backoffMaxMs);
  const retryAfter = retryAfterSeconds ? retryAfterSeconds * 1000 : 0;
  return Math.max(backoff, retryAfter);
}

/**
 * Framework-free polling engine behind `usePolling`.
 *
 * - One request at a time (in-flight guard + AbortController).
 * - No refresh while the tab is hidden; an immediate refresh when it becomes visible again.
 * - Exponential backoff after failures; the previous data stays available.
 * - `paused` freezes the display: no interval refreshes, no backoff retries, and returning to the
 *   tab does not reload. Only a key change or an explicit `refresh()` loads (once), and
 *   un-pausing refreshes immediately.
 * - `refresh()` during a request queues exactly one follow-up, so a state change made just before
 *   (pause/resume, a new replay) is never missed.
 */
export class Poller<T> {
  private state: PollState<T> = INITIAL as PollState<T>;
  private config: PollConfig<T> | null = null;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private running = false;
  private refreshQueued = false;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): PollState<T> => this.state;

  private set(patch: Partial<PollState<T>>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  /** Called from an effect with the latest options. Only a key change reloads. */
  configure(next: PollConfig<T>) {
    const previous = this.config;
    this.config = next;
    const keyChanged = !previous || previous.key !== next.key;
    // An error belongs to the request that failed; a different request starts clean.
    if (keyChanged && (this.state.error || this.state.failures > 0)) this.set({ error: null, errorKey: null, failures: 0 });
    if (!this.running) return;
    if (!previous || previous.key !== next.key) {
      this.cancelInFlight();
      void this.load();
    } else if (previous!.paused && !next.paused) {
      this.requestLoad(); // leaving "paused": catch up now instead of waiting a full interval
    } else if (previous!.intervalMs !== next.intervalMs || previous!.paused !== next.paused) {
      this.schedule();
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    document.addEventListener("visibilitychange", this.onVisibility);
    void this.load();
  }

  stop() {
    this.running = false;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.clearTimer();
    this.cancelInFlight();
  }

  /** Manual refresh (Retry button, after a write). While a request is running it queues one follow-up. */
  refresh = () => {
    if (!this.running) return;
    this.requestLoad();
  };

  private requestLoad() {
    if (this.state.fetching) this.refreshQueued = true;
    else void this.load();
  }

  private onVisibility = () => {
    if (document.hidden) {
      this.clearTimer();
      this.cancelInFlight();
    } else if (this.running) {
      const config = this.config;
      // A frozen display stays frozen when the tab comes back, unless it has nothing for its key yet.
      if (config?.paused && this.state.dataKey === config.key) return;
      void this.load();
    }
  };

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private cancelInFlight() {
    this.controller?.abort();
    this.controller = null;
  }

  private schedule(retryAfterSeconds?: number) {
    this.clearTimer();
    const config = this.config;
    if (!this.running || !config || document.hidden) return;
    if (config.paused) return;
    const delay = nextDelayMs(this.state.failures, config.intervalMs, retryAfterSeconds);
    this.timer = setTimeout(() => void this.load(), delay);
  }

  private async load() {
    const config = this.config;
    if (!this.running || !config || document.hidden) return;
    this.clearTimer();
    if (this.state.fetching) return;
    this.refreshQueued = false; // this load satisfies any queued refresh

    const controller = new AbortController();
    this.controller = controller;
    const { key } = config;
    this.set({ fetching: true });

    try {
      const data = await config.fetcher(controller.signal);
      if (controller.signal.aborted) return this.onAborted();
      this.set({ data, dataKey: key, error: null, errorKey: null, lastUpdatedAt: Date.now(), fetching: false, failures: 0 });
      this.schedule();
      this.runQueuedRefresh();
    } catch (cause) {
      if (controller.signal.aborted) return this.onAborted();
      const error =
        cause instanceof ApiError
          ? cause
          : new ApiError({ status: 0, code: "network", message: cause instanceof Error ? cause.message : "Request failed." });
      this.set({ error, errorKey: key, fetching: false, failures: this.state.failures + 1 });
      this.schedule(error.retryAfterSeconds);
      this.runQueuedRefresh();
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  private runQueuedRefresh() {
    if (this.refreshQueued && this.running) void this.load();
  }

  /** Superseded by a key change or a hidden tab: whoever aborted decides what happens next. */
  private onAborted() {
    this.set({ fetching: false });
    if (this.running && !document.hidden) void this.load();
  }
}
