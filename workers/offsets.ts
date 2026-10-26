import type { Admin } from "kafkajs";
import type { Db } from "mongodb";
import { CONSUMER_GROUP_IDS, CONSUMER_KEYS, TOPIC_NAME } from "@/shared/constants";
import { collections, type OffsetsDoc } from "@/lib/server/collections";
import type { WorkerState } from "./worker-state";

/**
 * Samples the log boundaries and each group's committed offsets from Kafka and stores them in
 * MongoDB so the web app can show lag without a Kafka connection of its own. Lag is
 * approximate: it is a snapshot taken at `sampledAt`, not a live measurement.
 */
export async function sampleOffsets(admin: Admin, db: Db, state: WorkerState, now: Date = new Date()): Promise<void> {
  const topicOffsets = await admin.fetchTopicOffsets(TOPIC_NAME);
  state.markKafkaOk();

  for (const key of CONSUMER_KEYS) {
    const groupId = CONSUMER_GROUP_IDS[key];
    const groups = await admin.fetchOffsets({ groupId, topics: [TOPIC_NAME] });
    const committed = new Map<number, string>();
    for (const topic of groups) {
      if (topic.topic !== TOPIC_NAME) continue;
      for (const p of topic.partitions) if (p.offset !== "-1") committed.set(p.partition, p.offset);
    }

    const doc: Omit<OffsetsDoc, "_id"> = {
      groupId,
      sampledAt: now,
      sampledBy: state.instanceId,
      partitions: topicOffsets
        .map((o) => ({
          partition: o.partition,
          committed: committed.get(o.partition) ?? null,
          earliest: o.low,
          latest: o.high,
        }))
        .sort((a, b) => a.partition - b.partition),
    };
    await collections(db).offsets.replaceOne({ _id: key }, doc, { upsert: true });
  }
}
