import type { Db } from "mongodb";
import type { ConsumerKey } from "@/shared/constants";
import type { ConsumerControlData } from "@/shared/api";
import { collections } from "./collections";

/**
 * Persists the desired pause state of a consumer group. Workers poll this document, so
 * every instance (including ones that start later) applies the same state; nothing is
 * kept only in one process's memory. Idempotent: repeating a request changes nothing.
 */
export async function setConsumerPaused(
  db: Db,
  key: ConsumerKey,
  paused: boolean,
  now: Date = new Date(),
): Promise<ConsumerControlData> {
  const commands = collections(db).commands;
  const existing = await commands.findOne({ _id: key });
  if (existing && existing.paused === paused) {
    return { key, paused, updatedAt: existing.updatedAt.toISOString() };
  }
  await commands.updateOne(
    { _id: key },
    { $set: { paused, pausedAt: paused ? now : null, updatedAt: now } },
    { upsert: true },
  );
  return { key, paused, updatedAt: now.toISOString() };
}
