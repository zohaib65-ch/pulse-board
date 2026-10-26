import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeEvent } from "./helpers/events";

// A scripted KafkaJS: producers are numbered in creation order and their `send` outcomes come from `script`.
const h = vi.hoisted(() => {
  type Producer = {
    id: number;
    disconnected: boolean;
    handlers: Record<string, () => void>;
    events: { DISCONNECT: string };
    on(event: string, fn: () => void): void;
    connect(): Promise<void>;
    send(): Promise<unknown>;
    disconnect(): Promise<void>;
  };
  const state = {
    producers: [] as Producer[],
    /** Called for every send: (producerId, callIndexOnThatProducer) → delay and whether it fails. */
    script: (() => ({ ms: 0, fail: false })) as (producer: number, call: number) => { ms: number; fail: boolean },
    calls: new Map<number, number>(),
  };
  return state;
});

vi.mock("kafkajs", () => ({
  logLevel: { NOTHING: 0, ERROR: 1, WARN: 2, INFO: 4, DEBUG: 5 },
  Kafka: class {
    producer() {
      const id = h.producers.length;
      const producer = {
        id,
        disconnected: false,
        handlers: {} as Record<string, () => void>,
        events: { DISCONNECT: "producer.disconnect" },
        on(event: string, fn: () => void) {
          producer.handlers[event] = fn;
        },
        async connect() {},
        async send() {
          const call = h.calls.get(id) ?? 0;
          h.calls.set(id, call + 1);
          const { ms, fail } = h.script(id, call);
          await new Promise((resolve) => setTimeout(resolve, ms));
          if (fail) throw new Error("connect ECONNREFUSED 10.0.0.1:9093");
          return [{ partition: 0, baseOffset: "1" }];
        },
        async disconnect() {
          producer.disconnected = true;
          producer.handlers["producer.disconnect"]?.();
        },
      };
      h.producers.push(producer);
      return producer;
    }
  },
}));

const PEM = (label: string) => `-----BEGIN ${label}-----\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n-----END ${label}-----\n`;
const saved = { ...process.env };
beforeAll(() => {
  Object.assign(process.env, {
    KAFKA_BROKERS: "broker.example.com:9093",
    KAFKA_CA_CERT: PEM("CERTIFICATE"),
    KAFKA_CLIENT_CERT: PEM("CERTIFICATE"),
    KAFKA_CLIENT_KEY: PEM("PRIVATE KEY"),
  });
});
afterAll(() => {
  process.env = saved;
});

describe("producer lifecycle", () => {
  it("a late failure on an old producer never tears down its healthy replacement", async () => {
    const { publishEvents, disconnectProducer } = await import("@/lib/server/kafka");
    await disconnectProducer();
    h.producers.length = 0;
    h.calls.clear();
    // Producer 0: send #0 fails fast (10 ms), send #1 fails late (90 ms). Producer 1: succeeds slowly (150 ms).
    h.script = (producer, call) => (producer === 0 ? { ms: call === 0 ? 10 : 90, fail: true } : { ms: 150, fail: false });

    const a = publishEvents([makeEvent()]).catch((error: Error) => error);
    const b = publishEvents([makeEvent()]).catch((error: Error) => error);
    await new Promise((resolve) => setTimeout(resolve, 40)); // A has failed and discarded producer 0
    const c = publishEvents([makeEvent()]); // creates producer 1
    const [ra, rb, rc] = await Promise.all([a, b, c]);

    expect(ra).toBeInstanceOf(Error);
    expect(rb).toBeInstanceOf(Error);
    expect(rc).toEqual([{ partition: 0, baseOffset: "1" }]);
    expect(h.producers).toHaveLength(2);
    expect(h.producers[0].disconnected).toBe(true);
    expect(h.producers[1].disconnected).toBe(false); // B's late failure did not disconnect it

    // And it is still the cached producer: the next request reuses it instead of creating a third.
    h.script = () => ({ ms: 0, fail: false });
    await publishEvents([makeEvent()]);
    expect(h.producers).toHaveLength(2);
    await disconnectProducer();
  });

  it("publishes with the sessionId as the message key and reports only sanitized failures", async () => {
    const { publishEvents, disconnectProducer, PublishError } = await import("@/lib/server/kafka");
    await disconnectProducer();
    h.script = () => ({ ms: 0, fail: true });
    const error = await publishEvents([makeEvent()]).catch((e) => e);
    expect(error).toBeInstanceOf(PublishError);
    expect(error.publicMessage).toBe("Could not reach the Kafka brokers.");
    expect(error.publicMessage).not.toContain("10.0.0.1");
    await disconnectProducer();
  });
});
