import type { Db } from "mongodb";
import {
  CONSUMER_GROUP_IDS,
  CONSUMER_KEYS,
  QUERY_LIMITS,
  RETENTION,
  TOPIC_NAME,
  TOPIC_PARTITIONS,
  WORKER,
  type ConsumerKey,
} from "@/shared/constants";
import type { GroupOffsets, GroupStatus, StatusData, WorkerStatus } from "@/shared/api";
import { collections, type OffsetsDoc, type WorkerDoc } from "../collections";

const MAX_WORKERS = 20;

function toWorkerStatus(doc: WorkerDoc, nowMs: number): WorkerStatus {
  const groups = {} as WorkerStatus["groups"];
  for (const key of CONSUMER_KEYS) {
    const g = doc.groups[key];
    groups[key] = {
      state: g.state,
      partitions: g.partitions,
      processed: g.processed,
      rejected: g.rejected,
      lastProcessedAt: g.lastProcessedAt?.toISOString() ?? null,
      lastError: g.lastError,
    };
  }
  return {
    instanceId: doc._id,
    startedAt: doc.startedAt.toISOString(),
    lastHeartbeatAt: doc.lastHeartbeatAt.toISOString(),
    stale: nowMs - doc.lastHeartbeatAt.getTime() > WORKER.staleAfterMs,
    kafkaConnected: doc.kafkaConnected,
    groups,
    replay: doc.replay,
  };
}

/** Lag = messages between the group's position and the log end (retained messages only). */
export function toGroupOffsets(doc: OffsetsDoc, nowMs: number): GroupOffsets {
  const partitions = doc.partitions
    .map((p) => {
      const earliest = BigInt(p.earliest);
      const latest = BigInt(p.latest);
      const position = p.committed === null ? earliest : BigInt(p.committed);
      const lag = latest - (position > earliest ? position : earliest);
      return { partition: p.partition, committed: p.committed, latest: p.latest, lag: Number(lag < 0n ? 0n : lag) };
    })
    .sort((a, b) => a.partition - b.partition);
  return {
    sampledAt: doc.sampledAt.toISOString(),
    stale: nowMs - doc.sampledAt.getTime() > WORKER.offsetStaleAfterMs,
    partitions,
    totalLag: partitions.reduce((sum, p) => sum + p.lag, 0),
  };
}

function effectiveState(workers: WorkerStatus[], key: ConsumerKey): GroupStatus["effective"] {
  const fresh = workers.filter((w) => !w.stale);
  if (fresh.length === 0) return "no_workers";
  const states = new Set(fresh.map((w) => w.groups[key].state));
  if (states.size === 1 && states.has("paused")) return "paused";
  if (states.size === 1 && states.has("running")) return "running";
  return "mixed";
}

export async function getStatus(db: Db, now: Date = new Date()): Promise<StatusData> {
  const nowMs = now.getTime();
  const c = collections(db);
  const [, workerDocs, commands, offsets, ingest, lastEvent] = await Promise.all([
    db.command({ ping: 1 }),
    c.workers.find({}).sort({ lastHeartbeatAt: -1 }).limit(MAX_WORKERS).maxTimeMS(QUERY_LIMITS.maxTimeMs).toArray(),
    c.commands.find({}).toArray(),
    c.offsets.find({}).toArray(),
    c.serviceState.findOne({ _id: "ingest" }),
    c.events.find({}, { projection: { timestamp: 1 } }).sort({ timestamp: -1 }).limit(1).maxTimeMS(QUERY_LIMITS.maxTimeMs).toArray(),
  ]);

  const workers = workerDocs.map((doc) => toWorkerStatus(doc, nowMs));
  const fresh = workers.filter((w) => !w.stale);

  const groups: GroupStatus[] = CONSUMER_KEYS.map((key) => {
    const command = commands.find((doc) => doc._id === key);
    const sampled = offsets.find((doc) => doc._id === key);
    return {
      key,
      groupId: CONSUMER_GROUP_IDS[key],
      paused: command?.paused ?? false,
      pausedAt: command?.pausedAt?.toISOString() ?? null,
      effective: effectiveState(workers, key),
      offsets: sampled ? toGroupOffsets(sampled, nowMs) : null,
    };
  });

  return {
    generatedAt: now.toISOString(),
    database: { ok: true },
    kafka: {
      topic: TOPIC_NAME,
      partitions: TOPIC_PARTITIONS,
      lastPublishAt: ingest?.lastPublishAt?.toISOString() ?? null,
      lastPublishError: ingest?.lastError
        ? { at: ingest.lastError.at.toISOString(), message: ingest.lastError.message }
        : null,
      workerConnected: fresh.length > 0 ? fresh.some((w) => w.kafkaConnected) : null,
    },
    workers,
    groups,
    lastEventAt: lastEvent[0]?.timestamp.toISOString() ?? null,
    retention: { historyHours: RETENTION.historyHours },
  };
}
