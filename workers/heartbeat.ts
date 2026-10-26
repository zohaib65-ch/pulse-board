import type { Db } from "mongodb";
import { RETENTION, WORKER } from "@/shared/constants";
import { collections } from "@/lib/server/collections";
import type { WorkerState } from "./worker-state";

/** Publishes this instance's status. The UI marks an instance stale if this stops. */
export async function writeHeartbeat(db: Db, state: WorkerState, now: Date = new Date()): Promise<void> {
  await collections(db).workers.updateOne(
    { _id: state.instanceId },
    {
      $set: {
        hostname: state.hostname,
        lastHeartbeatAt: now,
        kafkaConnected: state.kafkaConnected,
        groups: structuredClone(state.groups),
        replay: state.replay,
        expireAt: new Date(now.getTime() + RETENTION.workerDocHours * 3_600_000),
      },
      $setOnInsert: { startedAt: state.startedAt },
    },
    { upsert: true },
  );
}

/** On graceful shutdown the instance removes itself; a crashed one is left to go stale. */
export async function removeHeartbeat(db: Db, state: WorkerState): Promise<void> {
  await collections(db).workers.deleteOne({ _id: state.instanceId });
}

export const HEARTBEAT_INTERVAL_MS = WORKER.heartbeatIntervalMs;
