/** Pure display helpers. Browser-safe; no side effects. */

const numberFormat = new Intl.NumberFormat("en-US");
const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const shortTimeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export const EM_DASH = "—";

export function formatNumber(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? EM_DASH : numberFormat.format(value);
}

/** 1.2K / 3.4M for axis ticks. */
export function formatCompact(value: number): string {
  return compactFormat.format(value);
}

/** Ratio (0–1) as a percentage. `null` (zero denominator) renders as an em dash. */
export function formatPercent(ratio: number | null | undefined, digits = 0): string {
  if (ratio == null || !Number.isFinite(ratio)) return EM_DASH;
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Kafka offsets are 64-bit and travel as strings. */
export function formatOffset(offset: string | null | undefined): string {
  if (offset == null) return EM_DASH;
  try {
    return BigInt(offset).toLocaleString("en-US");
  } catch {
    return offset;
  }
}

export function shortId(id: string, length = 8): string {
  return id.slice(0, length);
}

function toDate(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Local time with seconds: 14:03:05. */
export function formatTime(value: string | number | Date | null | undefined): string {
  if (value == null) return EM_DASH;
  const date = toDate(value);
  return date ? timeFormat.format(date) : EM_DASH;
}

/** Local time without seconds, for chart ticks. */
export function formatClock(value: string | number | Date): string {
  const date = toDate(value);
  return date ? shortTimeFormat.format(date) : "";
}

/** 26 Oct, 14:03:05 (local). */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (value == null) return EM_DASH;
  const date = toDate(value);
  return date ? dateTimeFormat.format(date) : EM_DASH;
}

/** Time elapsed since `value` as "12s", "3m", "2h" or "3d" (no "ago"). `now` is passed in so callers control re-rendering. */
export function formatAge(value: string | number | Date | null | undefined, now: number): string {
  if (value == null) return EM_DASH;
  const date = toDate(value);
  if (!date) return EM_DASH;
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** "5s ago", "3m ago", "2h ago". */
export function formatRelative(value: string | number | Date | null | undefined, now: number): string {
  if (value == null) return EM_DASH;
  const date = toDate(value);
  if (!date) return EM_DASH;
  if (Math.round((now - date.getTime()) / 1000) < 5) return "just now";
  return `${formatAge(value, now)} ago`;
}

/**
 * Time of day (with seconds) when the timestamp is from today, otherwise the date and time, so an
 * old timestamp can never be mistaken for a recent one. `now` is passed in like `formatRelative`.
 */
export function formatWhen(value: string | number | Date | null | undefined, now: number): string {
  if (value == null) return EM_DASH;
  const date = toDate(value);
  if (!date) return EM_DASH;
  const today = new Date(now);
  const sameDay = now > 0 && date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return sameDay ? timeFormat.format(date) : dateTimeFormat.format(date);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}
