import type { ClientSession, Db, MongoClient } from "mongodb";
import { collections, type Collections } from "../collections";
import { isDuplicateKeyError, withTransaction } from "../mongo";
import type { MessageRecord, ParsedRecord } from "./records";

export interface MongoEnv {
  client: MongoClient;
  db: Db;
}

export const dedupeId = (groupId: string, eventId: string) => `${groupId}|${eventId}`;
export const rejectedId = (groupId: string, record: MessageRecord) =>
  `${groupId}|rejected|${record.partition}|${record.offset}`;

/**
 * Records that `groupId` has handled this message. Returns false when it already had.
 *
 * Uses an upsert with $setOnInsert instead of insertOne: a duplicate then reports
 * `upsertedCount === 0` instead of raising an error that would abort the surrounding
 * transaction. Two workers racing on the same message collide as a write conflict, the
 * driver retries the loser's transaction, and the retry sees the winner's record.
 */
export async function claim(
  c: Collections,
  session: ClientSession,
  id: string,
  doc: { groupId: string; kind: "event" | "rejected"; partition: number; offset: string; expireAt: Date },
  now: Date,
): Promise<boolean> {
  const result = await c.dedupe.updateOne(
    { _id: id },
    { $setOnInsert: { ...doc, processedAt: now } },
    { upsert: true, session },
  );
  return result.upsertedCount === 1;
}

/**
 * Runs a transactional unit of work, retrying when a concurrent upsert surfaces as a
 * duplicate-key error rather than a write conflict. The retry observes the committed
 * record and reports a duplicate.
 */
export async function runIdempotent<T>(env: MongoEnv, work: (session: ClientSession, c: Collections) => Promise<T>): Promise<T> {
  const c = collections(env.db);
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTransaction(env.client, (session) => work(session, c));
    } catch (error) {
      if (isDuplicateKeyError(error) && attempt < 3) continue;
      throw error;
    }
  }
}

export type Rejection = Extract<ParsedRecord, { ok: false }>;
