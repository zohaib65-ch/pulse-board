import type { MessageRecord, ProcessOutcome } from "./records";

export interface BatchMessage extends MessageRecord {
  offset: string;
}

export interface ConsumeDeps {
  messages: BatchMessage[];
  /** True while this group is paused: stop before touching the next message. */
  isPaused(): boolean;
  /** False once shutdown has started. */
  isRunning(): boolean;
  /** Applies one message to MongoDB. Throws on infrastructure failure (the batch is retried). */
  handle(record: BatchMessage): Promise<ProcessOutcome>;
  /** Marks the message as handled locally so the next fetch starts after it. */
  resolveOffset(offset: string): void;
  /** Commits `offset + 1` to Kafka. Only called after `handle` succeeded. */
  commit(nextOffset: string): Promise<void>;
  heartbeat(): Promise<void>;
  onOutcome?(outcome: ProcessOutcome): void;
}

export type StopReason = "drained" | "paused" | "stopped";

/**
 * The per-batch loop shared by both live consumers.
 *
 * For every message, strictly in order: apply it to MongoDB, mark the offset resolved, then
 * commit it to Kafka. A crash between "applied" and "committed" redelivers the message, which
 * the idempotent processors turn into a no-op (at-least-once delivery, exactly-once effect).
 *
 * When paused it returns without resolving the remaining messages; Kafka keeps them, and
 * after resume the next fetch starts exactly where this loop stopped.
 */
export async function consumeBatch(deps: ConsumeDeps): Promise<{ handled: number; stopReason: StopReason }> {
  let handled = 0;
  for (const message of deps.messages) {
    if (!deps.isRunning()) return { handled, stopReason: "stopped" };
    if (deps.isPaused()) return { handled, stopReason: "paused" };

    const outcome = await deps.handle(message);
    deps.resolveOffset(message.offset);
    await deps.commit((BigInt(message.offset) + 1n).toString());
    deps.onOutcome?.(outcome);
    handled++;
    await deps.heartbeat();
  }
  return { handled, stopReason: "drained" };
}
