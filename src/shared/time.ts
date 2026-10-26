import { RANGES, type RangeKey } from "./constants";

export function floorTo(ms: number, stepMs: number): number {
  return Math.floor(ms / stepMs) * stepMs;
}

export interface RangeWindow {
  fromMs: number;
  toMs: number;
  /** Chart bucket width in milliseconds. */
  chartBucketMs: number;
}

/**
 * The window for a range filter: the current (partial) minute plus the previous
 * `minutes - 1` whole minutes, so "15m" covers exactly 15 one-minute buckets.
 */
export function rangeWindow(range: RangeKey, nowMs: number): RangeWindow {
  const { minutes, chartBucketMinutes } = RANGES[range];
  const minuteMs = 60_000;
  return {
    fromMs: floorTo(nowMs, minuteMs) - (minutes - 1) * minuteMs,
    toMs: nowMs,
    chartBucketMs: chartBucketMinutes * minuteMs,
  };
}
