import { log } from "@/lib/server/log";
import { errorMessage } from "@/lib/server/errors";

/** Resolves after `ms`, or early when the signal aborts. Never rejects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Exponential backoff with jitter: initial · 2^attempt, capped, ±20%. */
export function backoffDelay(attempt: number, initialMs: number, maxMs: number): number {
  const base = Math.min(maxMs, initialMs * 2 ** attempt);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * A repeating task that never overlaps itself and never dies from a thrown error:
 * failures are logged and the next tick still runs.
 */
export class Loop {
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private inflight: Promise<void> = Promise.resolve();

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<void>,
  ) {}

  start(options: { immediately?: boolean } = {}): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(options.immediately === false ? this.intervalMs : 0);
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.inflight = this.run();
    }, delay);
  }

  private async run(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      log.warn(`${this.name} failed`, { error: errorMessage(error) });
    }
    if (!this.stopped) this.schedule(this.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inflight;
  }
}
