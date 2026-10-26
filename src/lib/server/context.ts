import type { Db } from "mongodb";
import { ensureIndexes } from "./collections";
import { log } from "./log";
import { errorMessage } from "./errors";
import { getMongo } from "./mongo";

/**
 * The database handle for a request. Indexes are created once per process (idempotent and
 * shared with the worker); a failure there must not take a read endpoint down.
 */
export async function requestDb(): Promise<Db> {
  const { db } = await getMongo();
  await ensureIndexes(db).catch((error) => log.warn("index creation failed", { error: errorMessage(error) }));
  return db;
}
