import { CONSUMER_GROUP_IDS, CONSUMER_KEYS, TOPIC_NAME, TOPIC_PARTITIONS, WORKER } from "@/shared/constants";
import { validateWorkerConfig } from "@/lib/server/config";
import { collections, ensureIndexes } from "@/lib/server/collections";
import { ConfigError, errorMessage } from "@/lib/server/errors";
import { createKafka } from "@/lib/server/kafka";
import { log } from "@/lib/server/log";
import { closeMongo, getMongo } from "@/lib/server/mongo";
import { processAlertsMessage } from "@/lib/server/processing/alerts";
import { processAnalyticsMessage } from "@/lib/server/processing/analytics";
import { GroupConsumer } from "./group-consumer";
import { removeHeartbeat, writeHeartbeat } from "./heartbeat";
import { sampleOffsets } from "./offsets";
import { ReplayRunner } from "./replay-runner";
import { ensureTopic } from "./topic";
import { Loop, backoffDelay, sleep } from "./util";
import { WorkerState } from "./worker-state";

/**
 * Pulseboard worker: the long-running process that consumes Kafka.
 *
 * One instance runs both consumer groups (analytics and alerts) plus the replay runner.
 * Start a second instance to watch the two partitions get split between them.
 * Run it as a daemon / container, never from a Route Handler or a request callback.
 */
async function main(): Promise<void> {
  try {
    validateWorkerConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      log.error("invalid worker configuration; refusing to start", { variables: error.variables, details: error.message });
      process.exit(1);
    }
    throw error;
  }

  const state = new WorkerState();
  log.info("worker starting", { instanceId: state.instanceId, topic: TOPIC_NAME, partitions: TOPIC_PARTITIONS });

  const mongo = await connectWithRetry();
  const kafka = createKafka(`pulseboard-worker-${state.instanceId.slice(0, 8)}`);
  const admin = kafka.admin();
  await connectAdminWithRetry(admin, state);

  const groupConsumers = [
    new GroupConsumer({
      key: "analytics",
      groupId: CONSUMER_GROUP_IDS.analytics,
      kafka,
      mongo,
      state,
      handle: (env, record) =>
        processAnalyticsMessage(env, { kind: "live", groupId: CONSUMER_GROUP_IDS.analytics }, record),
    }),
    new GroupConsumer({
      key: "alerts",
      groupId: CONSUMER_GROUP_IDS.alerts,
      kafka,
      mongo,
      state,
      handle: (env, record) => processAlertsMessage(env, CONSUMER_GROUP_IDS.alerts, record),
    }),
  ];
  const replay = new ReplayRunner(kafka, admin, mongo, state);

  // Persisted pause/resume commands: read once before consuming, then keep applying them.
  const readCommands = async () => {
    const docs = await collections(mongo.db).commands.find({}).toArray();
    for (const key of CONSUMER_KEYS) state.desiredPaused[key] = docs.find((doc) => doc._id === key)?.paused ?? false;
  };
  await readCommands();

  const loops = [
    new Loop("heartbeat", WORKER.heartbeatIntervalMs, () => writeHeartbeat(mongo.db, state)),
    new Loop("commands", WORKER.commandPollMs, async () => {
      await readCommands();
      await Promise.all(groupConsumers.map((consumer) => consumer.reconcilePause()));
    }),
    new Loop("offsets", WORKER.offsetSampleMs, () => sampleOffsets(admin, mongo.db, state)),
  ];

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    state.stopping = true;
    log.info("shutting down", { signal });
    const force = setTimeout(() => {
      log.error("shutdown timed out; exiting");
      process.exit(1);
    }, WORKER.shutdownTimeoutMs);
    force.unref();

    // Stop taking new work first, then release resources.
    await Promise.allSettled([replay.stop(), ...groupConsumers.map((consumer) => consumer.stop())]);
    await Promise.allSettled(loops.map((loop) => loop.stop()));
    await removeHeartbeat(mongo.db, state).catch(() => undefined);
    await admin.disconnect().catch(() => undefined);
    await closeMongo().catch(() => undefined);
    log.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: errorMessage(reason) }));

  loops.forEach((loop) => loop.start());
  groupConsumers.forEach((consumer) => consumer.start());
  replay.start();
  log.info("worker running", { instanceId: state.instanceId, groups: CONSUMER_KEYS.map((key) => CONSUMER_GROUP_IDS[key]) });
}

/** Keeps trying until MongoDB is reachable (an Atlas outage must not crash-loop the daemon). */
async function connectWithRetry() {
  for (let attempt = 0; ; attempt++) {
    try {
      const connection = await getMongo();
      await connection.db.command({ ping: 1 });
      await ensureIndexes(connection.db);
      return connection;
    } catch (error) {
      const delay = backoffDelay(attempt, WORKER.reconnectBackoff.initialMs, WORKER.reconnectBackoff.maxMs);
      log.error("cannot reach MongoDB; retrying", { error: errorMessage(error), inMs: delay });
      await sleep(delay);
    }
  }
}

/** Connects the admin client and verifies the topic, retrying through broker outages. */
async function connectAdminWithRetry(admin: ReturnType<ReturnType<typeof createKafka>["admin"]>, state: WorkerState) {
  for (let attempt = 0; ; attempt++) {
    try {
      await admin.connect();
      await ensureTopic(admin);
      state.markKafkaOk();
      return;
    } catch (error) {
      await admin.disconnect().catch(() => undefined);
      const delay = backoffDelay(attempt, WORKER.reconnectBackoff.initialMs, WORKER.reconnectBackoff.maxMs);
      log.error("cannot reach Kafka or the topic; retrying", { error: errorMessage(error), inMs: delay });
      await sleep(delay);
    }
  }
}

main().catch((error) => {
  log.error("worker crashed during startup", { error: errorMessage(error) });
  process.exit(1);
});
