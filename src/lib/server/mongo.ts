import { MongoClient, type ClientSession, type Db, type TransactionOptions } from "mongodb";
import { TX } from "@/shared/constants";
import { getMongoConfig } from "./config";

export interface MongoConnection {
  client: MongoClient;
  db: Db;
}

/** One connection per process (reused across requests and hot reloads). */
const globalForMongo = globalThis as unknown as { __pulseboardMongo?: Promise<MongoConnection> };

async function connect(): Promise<MongoConnection> {
  const { uri, dbName } = getMongoConfig();
  const client = new MongoClient(uri, {
    appName: "pulseboard",
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    socketTimeoutMS: 30_000,
  });
  await client.connect();
  // The database name comes from the connection string; there is no separate variable.
  return { client, db: client.db(dbName) };
}

export function getMongo(): Promise<MongoConnection> {
  if (!globalForMongo.__pulseboardMongo) {
    const pending = connect().catch((error) => {
      // Do not cache a failed connection; the next call retries.
      globalForMongo.__pulseboardMongo = undefined;
      throw error;
    });
    globalForMongo.__pulseboardMongo = pending;
  }
  return globalForMongo.__pulseboardMongo;
}

export async function closeMongo(): Promise<void> {
  const pending = globalForMongo.__pulseboardMongo;
  globalForMongo.__pulseboardMongo = undefined;
  if (pending) {
    const { client } = await pending.catch(() => ({ client: undefined }));
    await client?.close();
  }
}

const TRANSACTION_OPTIONS: TransactionOptions = {
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
  readPreference: "primary",
  maxCommitTimeMS: TX.maxCommitTimeMs,
};

/**
 * Runs `fn` in a transaction. The driver retries the callback on TransientTransactionError
 * (write conflicts between workers) and retries an unknown commit result, so `fn` must only
 * touch MongoDB and must be safe to run more than once.
 */
export async function withTransaction<T>(
  client: MongoClient,
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = client.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await fn(session);
    }, TRANSACTION_OPTIONS);
    return result as T;
  } finally {
    await session.endSession();
  }
}

export function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}
