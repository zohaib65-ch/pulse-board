import type { Admin } from "kafkajs";
import { TOPIC_NAME, TOPIC_PARTITIONS } from "@/shared/constants";
import { errorMessage } from "@/lib/server/errors";
import { log } from "@/lib/server/log";

/**
 * Makes sure the topic exists with the expected partition count. Creating it is a convenience:
 * on a service where the user has no permission to create topics this only logs a warning,
 * and the README tells you to create the topic in the Aiven console.
 */
export async function ensureTopic(admin: Admin): Promise<void> {
  const existing = await admin.listTopics();
  if (!existing.includes(TOPIC_NAME)) {
    log.warn("topic missing, trying to create it", { topic: TOPIC_NAME, partitions: TOPIC_PARTITIONS });
    try {
      await admin.createTopics({ topics: [{ topic: TOPIC_NAME, numPartitions: TOPIC_PARTITIONS }], waitForLeaders: true });
    } catch (error) {
      throw new Error(
        `Topic ${TOPIC_NAME} does not exist and could not be created (${errorMessage(error)}). ` +
          `Create it with ${TOPIC_PARTITIONS} partitions in the Aiven console.`,
      );
    }
    return;
  }
  const metadata = await admin.fetchTopicMetadata({ topics: [TOPIC_NAME] });
  const partitions = metadata.topics.find((topic) => topic.name === TOPIC_NAME)?.partitions.length ?? 0;
  if (partitions !== TOPIC_PARTITIONS) {
    log.warn("topic has an unexpected partition count", { topic: TOPIC_NAME, expected: TOPIC_PARTITIONS, actual: partitions });
  }
}
