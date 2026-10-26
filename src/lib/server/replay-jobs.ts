import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { REPLAY, REPLAY_GROUP_PREFIX, RETENTION } from "@/shared/constants";
import type { ReplayJobData, ReplayPartitionProgress } from "@/shared/api";
import { ApiError, publicErrorMessage } from "./errors";
import { collections, type ReplayJobDoc } from "./collections";
import { isDuplicateKeyError } from "./mongo";
import { toReplayJobData } from "./queries/replay";

/**
 * Replay job lifecycle in MongoDB.
 *
 * The API only creates a job. A worker claims it atomically and holds a lease that it must
 * keep renewing; if the worker dies the lease expires and another worker takes the job over.
 * A unique partial index on `active` guarantees at most one queued/running job at a time.
 */

export async function createReplayJob(db: Db, now: Date = new Date()): Promise<ReplayJobData> {
  const id = randomUUID();
  const doc: ReplayJobDoc = {
    _id: id,
    status: "queued",
    groupId: `${REPLAY_GROUP_PREFIX}${id}`,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    active: true,
    attempt: 0,
    lease: null,
    partitions: [],
    processed: 0,
    rejected: 0,
    truncated: false,
    error: null,
    expireAt: new Date(now.getTime() + RETENTION.replayResultHours * 3_600_000),
  };
  try {
    await collections(db).replayJobs.insertOne(doc);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new ApiError(409, "conflict", "A replay is already queued or running. Wait for it to finish.");
    }
    throw error;
  }
  return toReplayJobData(doc);
}

/** Fails jobs that have used up their attempts and whose lease has lapsed. */
async function failExhaustedJobs(db: Db, now: Date): Promise<void> {
  await collections(db).replayJobs.updateMany(
    {
      active: true,
      attempt: { $gte: REPLAY.maxAttempts },
      $or: [{ lease: null }, { "lease.expiresAt": { $lt: now } }],
    },
    {
      $set: {
        status: "failed",
        finishedAt: now,
        lease: null,
        error: `Gave up after ${REPLAY.maxAttempts} attempts (the worker was interrupted or kept failing).`,
      },
      $unset: { active: "" },
    },
  );
}

/** Atomically claims the oldest unleased (or lease-expired) job for `owner`, or returns null. */
export async function claimReplayJob(db: Db, owner: string, now: Date = new Date()): Promise<ReplayJobDoc | null> {
  await failExhaustedJobs(db, now);
  return collections(db).replayJobs.findOneAndUpdate(
    {
      active: true,
      attempt: { $lt: REPLAY.maxAttempts },
      $or: [{ lease: null }, { "lease.expiresAt": { $lt: now } }],
    },
    [
      {
        $set: {
          status: "running",
          attempt: { $add: ["$attempt", 1] },
          startedAt: { $ifNull: ["$startedAt", now] },
          lease: { owner, expiresAt: new Date(now.getTime() + REPLAY.leaseMs) },
        },
      },
    ],
    { sort: { createdAt: 1 }, returnDocument: "after" },
  );
}

/** Extends the lease. Returns false if this owner no longer holds it (the job was taken over). */
export async function renewLease(db: Db, runId: string, owner: string, now: Date = new Date()): Promise<boolean> {
  const result = await collections(db).replayJobs.updateOne(
    { _id: runId, status: "running", "lease.owner": owner },
    { $set: { "lease.expiresAt": new Date(now.getTime() + REPLAY.leaseMs) } },
  );
  return result.matchedCount === 1;
}

/** Boundaries are captured once and then reused by retries so every attempt reads the same range. */
export async function saveBoundaries(
  db: Db,
  runId: string,
  partitions: ReplayPartitionProgress[],
  truncated: boolean,
): Promise<void> {
  await collections(db).replayJobs.updateOne({ _id: runId, partitions: { $size: 0 } }, { $set: { partitions, truncated } });
}

export async function saveProgress(
  db: Db,
  runId: string,
  owner: string,
  partitions: ReplayPartitionProgress[],
): Promise<boolean> {
  const result = await collections(db).replayJobs.updateOne(
    { _id: runId, "lease.owner": owner },
    { $set: { partitions } },
  );
  return result.matchedCount === 1;
}

export async function completeJob(db: Db, runId: string, owner: string, now: Date = new Date()): Promise<void> {
  await collections(db).replayJobs.updateOne(
    { _id: runId, "lease.owner": owner },
    { $set: { status: "completed", finishedAt: now, lease: null, error: null }, $unset: { active: "" } },
  );
}

/**
 * Gives a job back after an interruption. A graceful shutdown (`interrupted`) does not use up
 * an attempt; a real failure records the error and is retried until attempts run out.
 */
export async function releaseJob(
  db: Db,
  runId: string,
  owner: string,
  reason: { interrupted: true } | { error: unknown },
  now: Date = new Date(),
): Promise<void> {
  const jobs = collections(db).replayJobs;
  if ("interrupted" in reason) {
    await jobs.updateOne(
      { _id: runId, "lease.owner": owner },
      { $set: { status: "queued", lease: null }, $inc: { attempt: -1 } },
    );
    return;
  }
  // Exposed by the public replay endpoints, so never raw driver text (it can contain hostnames).
  const message = publicErrorMessage(reason.error).slice(0, 300);
  const released = await jobs.updateOne(
    { _id: runId, "lease.owner": owner, attempt: { $lt: REPLAY.maxAttempts } },
    { $set: { status: "queued", lease: null, error: message } },
  );
  if (released.matchedCount === 0) {
    await jobs.updateOne(
      { _id: runId, "lease.owner": owner },
      { $set: { status: "failed", finishedAt: now, lease: null, error: message }, $unset: { active: "" } },
    );
  }
}
