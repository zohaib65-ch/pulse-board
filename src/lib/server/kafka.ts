import { Kafka, logLevel, type Producer, type RecordMetadata } from "kafkajs";
import { TOPIC_NAME } from "@/shared/constants";
import type { WebsiteEvent } from "@/shared/event-schema";
import { getKafkaConfig } from "./config";
import { describeInfraError, errorMessage } from "./errors";
import { log } from "./log";

/**
 * Creates a KafkaJS client using Aiven's mutual TLS: the CA certificate verifies the broker,
 * and the client certificate + key authenticate us. Certificate verification stays enabled.
 */
export function createKafka(
  clientId: string,
  options: { retries?: number; requestTimeout?: number; connectionTimeout?: number } = {},
): Kafka {
  const config = getKafkaConfig();
  return new Kafka({
    clientId,
    brokers: config.brokers,
    ssl: {
      ca: [config.ca],
      cert: config.cert,
      key: config.key,
      rejectUnauthorized: true,
    },
    connectionTimeout: options.connectionTimeout ?? 8000,
    requestTimeout: options.requestTimeout ?? 15_000,
    retry: { initialRetryTime: 300, maxRetryTime: 15_000, retries: options.retries ?? 5 },
    logLevel: logLevel.WARN,
    logCreator:
      () =>
      ({ level, log: entry }) => {
        const { message, namespace, timestamp: _timestamp, logger: _logger, ...rest } = entry;
        void _timestamp;
        void _logger;
        const fields = { namespace, ...rest };
        if (level === logLevel.ERROR) log.error(`kafkajs: ${message}`, fields);
        else log.warn(`kafkajs: ${message}`, fields);
      },
  });
}

// ── Producer used by the Route Handlers ─────────────────────────────────────
interface ProducerEntry {
  promise: Promise<Producer>;
  /** Set once connected; teardown disconnects exactly this producer. */
  producer?: Producer;
}

const globalForKafka = globalThis as unknown as { __pulseboardProducer?: ProducerEntry };

async function connectProducer(entry: ProducerEntry): Promise<Producer> {
  // Short budget: an HTTP request should fail within about ten seconds, not hang on a dead broker.
  const kafka = createKafka("pulseboard-web", { retries: 1, requestTimeout: 5000, connectionTimeout: 4000 });
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  await producer.connect();
  entry.producer = producer;
  producer.on(producer.events.DISCONNECT, () => {
    // Only forget this producer; a replacement created meanwhile must stay cached.
    if (globalForKafka.__pulseboardProducer === entry) globalForKafka.__pulseboardProducer = undefined;
  });
  return producer;
}

function getProducerEntry(): ProducerEntry {
  const existing = globalForKafka.__pulseboardProducer;
  if (existing) return existing;
  const entry: ProducerEntry = { promise: undefined as unknown as Promise<Producer> };
  entry.promise = connectProducer(entry).catch((error) => {
    if (globalForKafka.__pulseboardProducer === entry) globalForKafka.__pulseboardProducer = undefined;
    throw error;
  });
  globalForKafka.__pulseboardProducer = entry;
  return entry;
}

/** Drops a failed producer: uncaches it only if it is still the cached one, and disconnects that one only. */
async function discardProducer(entry: ProducerEntry): Promise<void> {
  if (globalForKafka.__pulseboardProducer === entry) globalForKafka.__pulseboardProducer = undefined;
  await entry.producer?.disconnect().catch(() => undefined);
}

export async function disconnectProducer(): Promise<void> {
  const entry = globalForKafka.__pulseboardProducer;
  if (entry) await discardProducer(entry);
}

export interface PublishAck {
  partition: number;
  baseOffset: string;
}

export class PublishError extends Error {
  /** Safe to show to anyone: no hostnames or broker details. */
  readonly publicMessage: string;

  constructor(message: string) {
    super(message);
    this.name = "PublishError";
    this.publicMessage = describePublishFailure(message);
  }
}

/** Maps a raw client error to a generic description for the public status endpoint. */
export function describePublishFailure(raw: string): string {
  return describeInfraError(raw, "kafka");
}

/**
 * Publishes events keyed by sessionId (so one session always lands on one partition, in order)
 * and resolves only after the brokers acknowledge the write (acks = all in-sync replicas).
 */
export async function publishEvents(events: WebsiteEvent[]): Promise<PublishAck[]> {
  const entry = getProducerEntry();
  try {
    const producer = await entry.promise;
    const metadata: RecordMetadata[] = await producer.send({
      topic: TOPIC_NAME,
      acks: -1,
      timeout: 5000,
      messages: events.map((event) => ({
        key: event.sessionId,
        value: JSON.stringify(event),
        headers: { "content-type": "application/json", "schema-version": "1" },
      })),
    });
    return metadata.map((entry) => ({ partition: entry.partition, baseOffset: entry.baseOffset ?? "0" }));
  } catch (error) {
    // A failed send can leave this producer in a bad state; the next request reconnects.
    await discardProducer(entry);
    throw new PublishError(errorMessage(error));
  }
}

