import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { inject } from "vitest";
import { createIndexes } from "@/lib/server/collections";
import type { MongoEnv } from "@/lib/server/processing/shared";

/** A fresh, uniquely named database on the shared in-memory replica set. */
export async function createTestDb(): Promise<MongoEnv & { uri: string; dbName: string; drop(): Promise<void> }> {
  const base = inject("mongoUri");
  const dbName = `test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const client = new MongoClient(base);
  await client.connect();
  const db = client.db(dbName);
  await createIndexes(db);
  const uri = base.replace(/\/?(\?|$)/, `/${dbName}$1`);
  return {
    client,
    db,
    uri,
    dbName,
    async drop() {
      await db.dropDatabase();
      await client.close();
    },
  };
}
