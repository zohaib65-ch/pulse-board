import { formatRelative } from "@/lib/format";
import type { GroupStatus, ReplayStatus, StatusData, WorkerStatus } from "@/shared/api";

/** Pure derivations of the status payload for display. Nothing here invents data. */

export type Tone = "ok" | "warn" | "bad" | "unknown";

export interface Described {
  label: string;
  tone: Tone;
}

export function describeGroup(group: GroupStatus): Described {
  if (group.effective === "no_workers") {
    return group.paused ? { label: "Paused · no workers", tone: "warn" } : { label: "No workers reporting", tone: "bad" };
  }
  if (group.effective === "mixed") return { label: "Applying change", tone: "warn" };
  if (group.effective === "paused") return { label: "Paused", tone: "warn" };
  return { label: "Running", tone: "ok" };
}

export function liveWorkers(workers: WorkerStatus[]): WorkerStatus[] {
  return workers.filter((worker) => !worker.stale);
}

export function describeWorkers(workers: WorkerStatus[]): Described & { live: number; stale: number } {
  const live = liveWorkers(workers).length;
  const stale = workers.length - live;
  if (workers.length === 0) return { label: "None reporting", tone: "bad", live, stale };
  if (live === 0) return { label: `${stale} stale`, tone: "bad", live, stale };
  const label = `${live} live${stale > 0 ? `, ${stale} stale` : ""}`;
  return { label, tone: stale > 0 ? "warn" : "ok", live, stale };
}

/** A publish counts as "recent" (green) only if it happened within this window. */
export const RECENT_PUBLISH_MS = 2 * 60 * 1000;

/**
 * Only claims what the data shows: when the last publish happened, and whether a newer attempt
 * failed. An old publish is neutral, not green, because it says nothing about Kafka right now.
 */
export function describeKafkaPublish(kafka: StatusData["kafka"], now: number): Described {
  const lastOk = kafka.lastPublishAt ? Date.parse(kafka.lastPublishAt) : null;
  const lastError = kafka.lastPublishError ? Date.parse(kafka.lastPublishError.at) : null;
  if (lastError !== null && (lastOk === null || lastError > lastOk)) return { label: "Last publish failed", tone: "bad" };
  if (lastOk === null) return { label: "No publish yet", tone: "unknown" };
  if (now <= 0) return { label: "Last publish recorded", tone: "unknown" };
  return { label: `Last publish ${formatRelative(lastOk, now)}`, tone: now - lastOk <= RECENT_PUBLISH_MS ? "ok" : "unknown" };
}

/**
 * When the status request itself is failing or old, nothing in it can be called healthy: show the
 * last known value as unknown rather than as a green badge.
 */
export function withStaleness(described: Described, stale: boolean): Described {
  return stale ? { label: `Unknown · last known: ${described.label}`, tone: "unknown" } : described;
}

export function describeReplayStatus(status: ReplayStatus): Described {
  switch (status) {
    case "queued":
      return { label: "Queued", tone: "unknown" };
    case "running":
      return { label: "Running", tone: "warn" };
    case "completed":
      return { label: "Completed", tone: "ok" };
    case "failed":
      return { label: "Failed", tone: "bad" };
  }
}

export function isReplayActive(status: ReplayStatus): boolean {
  return status === "queued" || status === "running";
}
