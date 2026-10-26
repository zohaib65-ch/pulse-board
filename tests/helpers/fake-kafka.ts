import type { Kafka } from "kafkajs";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface FakeConsumerOptions {
  connectMs?: number;
  runMs?: number;
  /** Rejects `subscribe` with this message (after a successful connect). */
  failSubscribe?: string;
  failConnect?: string;
  /** Called once `run` has registered its handler, to feed batches like Kafka would. */
  feed?: (consumer: FakeConsumer) => void | Promise<void>;
}

type EachBatch = (payload: {
  batch: { topic: string; partition: number; messages: { offset: string; value: Buffer | string | null }[]; lastOffset(): string };
  resolveOffset(offset: string): void;
  heartbeat(): Promise<void>;
  isRunning(): boolean;
  pause(): () => void;
}) => Promise<void>;

/** The slice of a KafkaJS consumer the worker uses, with every call recorded. */
export class FakeConsumer {
  readonly events = {
    HEARTBEAT: "consumer.heartbeat",
    FETCH: "consumer.fetch",
    GROUP_JOIN: "consumer.group_join",
    REBALANCING: "consumer.rebalancing",
    CRASH: "consumer.crash",
    STOP: "consumer.stop",
    CONNECT: "consumer.connect",
    DISCONNECT: "consumer.disconnect",
  };
  readonly calls: string[] = [];
  readonly commits: { partition: number; offset: string }[] = [];
  readonly resolved: string[] = [];
  readonly paused: unknown[] = [];
  eachBatch?: EachBatch;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly config: { groupId: string }, private readonly options: FakeConsumerOptions = {}) {}

  on(event: string, listener: (event: unknown) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return () => undefined;
  }
  emit(event: string, payload: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener({ payload });
  }

  async connect() {
    this.calls.push("connect");
    await sleep(this.options.connectMs ?? 0);
    if (this.options.failConnect) throw new Error(this.options.failConnect);
  }
  async subscribe() {
    this.calls.push("subscribe");
    if (this.options.failSubscribe) throw new Error(this.options.failSubscribe);
  }
  async run(config: { eachBatch: EachBatch }) {
    this.calls.push("run");
    this.eachBatch = config.eachBatch;
    await sleep(this.options.runMs ?? 0);
    if (this.options.feed) setTimeout(() => void this.options.feed?.(this), 0);
  }
  async stop() {
    this.calls.push("stop");
  }
  async disconnect() {
    this.calls.push("disconnect");
  }
  pause(partitions: unknown) {
    this.calls.push("pause");
    this.paused.push(partitions);
  }
  resume() {
    this.calls.push("resume");
  }
  async commitOffsets(offsets: { partition: number; offset: string }[]) {
    this.commits.push(...offsets.map(({ partition, offset }) => ({ partition, offset })));
  }

  /** Delivers one batch the way KafkaJS would. */
  async deliver(
    partition: number,
    messages: { offset: string; value: Buffer | string | null }[],
    behaviour: { isRunning?: () => boolean; onPause?: () => void } = {},
  ) {
    await this.eachBatch!({
      batch: {
        topic: "website-events",
        partition,
        messages,
        lastOffset: () => messages.at(-1)?.offset ?? "0",
      },
      resolveOffset: (offset) => this.resolved.push(offset),
      heartbeat: async () => undefined,
      isRunning: behaviour.isRunning ?? (() => true),
      pause: () => {
        behaviour.onPause?.();
        this.calls.push("batch-pause");
        return () => undefined;
      },
    });
  }
}

export class FakeKafka {
  readonly consumers: FakeConsumer[] = [];
  constructor(private readonly options: (index: number) => FakeConsumerOptions = () => ({})) {}
  consumer = (config: { groupId: string }) => {
    const consumer = new FakeConsumer(config, this.options(this.consumers.length));
    this.consumers.push(consumer);
    return consumer;
  };
  asKafka() {
    return this as unknown as Kafka;
  }
}

export interface FakeAdminOptions {
  offsets: { partition: number; low: string; high: string }[];
}

export function fakeAdmin({ offsets }: FakeAdminOptions) {
  const deletedGroups: string[] = [];
  return {
    deletedGroups,
    fetchTopicOffsets: async () => offsets.map((o) => ({ ...o, offset: o.high })),
    deleteGroups: async (groups: string[]) => void deletedGroups.push(...groups),
  };
}

export const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 3000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(10);
  }
  return false;
};

export { sleep };
