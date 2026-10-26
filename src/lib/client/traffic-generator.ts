/**
 * Browser-side traffic generator for the Kafka Lab. Framework-free so it can be unit-tested:
 * planning and pacing are pure functions, and the runner takes its side effects (send, sleep,
 * clock, ids, randomness) as injected dependencies.
 *
 * The server enforces the same limits independently (per run id and per second); this class
 * simply paces itself to stay inside them.
 */
import { z } from "zod";
import type { IngestData } from "@/shared/api";
import { PAGES, PRODUCTS } from "@/shared/catalog";
import { SIMULATOR_LIMITS, type EventType } from "@/shared/constants";
import type { IngestRequest, WebsiteEvent } from "@/shared/event-schema";
import { ApiError } from "./api";
import { newId } from "./ids";

export const GENERATOR_MODES = ["random", "spike"] as const;
export type GeneratorMode = (typeof GENERATOR_MODES)[number];

export const GENERATOR_MODE_LABELS: Record<GeneratorMode, string> = {
  random: "Random traffic",
  spike: "Spike burst",
};

/** Shortest rate at which the 60-event spike still fits inside one minute of sending. */
export const SPIKE_MIN_RATE = 2;
export const MAX_RETRIES = 3;

export const generatorFormSchema = z
  .object({
    // NaN is tolerated here on purpose: the field is unmounted in spike mode, where it is ignored.
    // For random mode it is validated below, so a cleared field still produces a visible error.
    events: z.union([z.number(), z.nan()]),
    ratePerSecond: z
      .number({ error: "Enter a whole number" })
      .int("Enter a whole number")
      .min(1, "At least 1 event per second")
      .max(SIMULATOR_LIMITS.maxEventsPerSecond, `At most ${SIMULATOR_LIMITS.maxEventsPerSecond} events per second`),
    mode: z.enum(GENERATOR_MODES),
  })
  .superRefine((form, ctx) => {
    if (form.mode === "spike") {
      // A spike always sends `spikeBurstSize` events; `events` plays no part.
      if (form.ratePerSecond < SPIKE_MIN_RATE) {
        ctx.addIssue({ code: "custom", path: ["ratePerSecond"], message: `A spike needs at least ${SPIKE_MIN_RATE} events per second` });
      }
      return;
    }
    const { events } = form;
    if (!Number.isInteger(events)) {
      ctx.addIssue({ code: "custom", path: ["events"], message: "Enter a whole number" });
    } else if (events < 1) {
      ctx.addIssue({ code: "custom", path: ["events"], message: "At least 1 event" });
    } else if (events > SIMULATOR_LIMITS.maxEventsPerRun) {
      ctx.addIssue({ code: "custom", path: ["events"], message: `At most ${SIMULATOR_LIMITS.maxEventsPerRun} events per run` });
    }
  });

export type GeneratorForm = z.infer<typeof generatorFormSchema>;

// ── Planning (pure) ─────────────────────────────────────────────────────────

export interface PlannedEvent {
  type: EventType;
  sessionId: string;
  page: string;
  productId?: string;
  /** Fixed timestamp (spike mode). Otherwise the event is stamped when it is sent. */
  timestamp?: string;
}

export interface PlanInput {
  mode: GeneratorMode;
  count: number;
  now: number;
  random?: () => number;
  uuid?: () => string;
}

/** The simulator only produces the original three types; orders and removals come from real storefronts. */
type SimulatedType = "page_view" | "product_click" | "add_to_cart";

const TYPE_WEIGHTS: { type: SimulatedType; weight: number }[] = [
  { type: "page_view", weight: 0.6 },
  { type: "product_click", weight: 0.28 },
  { type: "add_to_cart", weight: 0.12 },
];

const pick = <T>(items: readonly T[], random: () => number): T => items[Math.min(items.length - 1, Math.floor(random() * items.length))]!;

function pickType(random: () => number): SimulatedType {
  let roll = random();
  for (const { type, weight } of TYPE_WEIGHTS) {
    if (roll < weight) return type;
    roll -= weight;
  }
  return "page_view";
}

function plannedFor(type: SimulatedType, sessionId: string, random: () => number): PlannedEvent {
  const product = pick(PRODUCTS, random);
  switch (type) {
    case "page_view":
      return { type, sessionId, page: pick(PAGES, random).path };
    case "product_click":
      return { type, sessionId, page: random() < 0.5 ? "/products" : `/products/${product.id}`, productId: product.id };
    case "add_to_cart":
      return { type, sessionId, page: `/products/${product.id}`, productId: product.id };
  }
}

/** Number of events a run will send for this mode. */
export function plannedCount(mode: GeneratorMode, requested: number): number {
  return mode === "spike" ? SIMULATOR_LIMITS.spikeBurstSize : Math.min(requested, SIMULATOR_LIMITS.maxEventsPerRun);
}

export function planRun({ mode, count, now, random = Math.random, uuid = newId }: PlanInput): PlannedEvent[] {
  const total = plannedCount(mode, count);

  if (mode === "spike") {
    // One session, every timestamp inside the same tumbling minute, so the server's
    // "more than 50 events per session per minute" rule always sees the whole burst together.
    const sessionId = uuid();
    const windowStart = Math.floor(now / 60_000) * 60_000;
    const spacingMs = 900;
    const order: SimulatedType[] = ["page_view", "product_click", "page_view", "add_to_cart"];
    return Array.from({ length: total }, (_, index) => ({
      ...plannedFor(order[index % order.length]!, sessionId, random),
      timestamp: new Date(windowStart + index * spacingMs).toISOString(),
    }));
  }

  const sessionCount = Math.min(8, Math.max(2, Math.ceil(total / 6)));
  const sessions = Array.from({ length: sessionCount }, () => uuid());
  return Array.from({ length: total }, () => plannedFor(pickType(random), pick(sessions, random), random));
}

export function buildEvent(
  planned: PlannedEvent,
  { now, uuid = newId }: { now: number; uuid?: () => string },
): WebsiteEvent {
  return {
    eventId: uuid(),
    type: planned.type,
    timestamp: planned.timestamp ?? new Date(now).toISOString(),
    sessionId: planned.sessionId,
    page: planned.page,
    ...(planned.productId ? { productId: planned.productId } : {}),
    source: "simulator",
  };
}

// ── Pacing & retries (pure) ─────────────────────────────────────────────────

/** Time between sends so the average rate never exceeds `ratePerSecond`. Each request carries one event. */
export function sendIntervalMs(ratePerSecond: number): number {
  const rate = Math.min(Math.max(1, ratePerSecond), SIMULATOR_LIMITS.maxEventsPerSecond);
  return Math.ceil(1000 / rate);
}

export function retryDelayMs(attempt: number, error: ApiError): number {
  const backoff = 500 * 2 ** attempt; // 500ms, 1s, 2s
  const retryAfter = error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : 0;
  return Math.max(backoff, retryAfter);
}

// ── Runner ──────────────────────────────────────────────────────────────────

export type GeneratorStatus = "idle" | "running" | "completed" | "stopped" | "failed";

export interface GeneratorState {
  status: GeneratorStatus;
  runId: string | null;
  mode: GeneratorMode;
  planned: number;
  /** Events Kafka has acknowledged. */
  accepted: number;
  /** Events given up on after a terminal error or exhausted retries. */
  failed: number;
  /** Retried requests; each retry reuses the same event ids. */
  retries: number;
  lastAck: { partition: number; baseOffset: string } | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface GeneratorDeps {
  send: (body: IngestRequest) => Promise<IngestData>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  uuid?: () => string;
  random?: () => number;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });

export const IDLE_STATE: GeneratorState = {
  status: "idle",
  runId: null,
  mode: "random",
  planned: 0,
  accepted: 0,
  failed: 0,
  retries: 0,
  lastAck: null,
  error: null,
  startedAt: null,
  finishedAt: null,
};

export class TrafficGenerator {
  private state: GeneratorState = IDLE_STATE;
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private deps: Required<GeneratorDeps>;

  constructor(deps: GeneratorDeps) {
    this.deps = {
      sleep: defaultSleep,
      now: () => Date.now(),
      uuid: newId,
      random: Math.random,
      ...deps,
    };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.state;

  /** Swap the transport (e.g. when the admin token changes). */
  setSender(send: GeneratorDeps["send"]) {
    this.deps.send = send;
  }

  private update(patch: Partial<GeneratorState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  get isRunning() {
    return this.state.status === "running";
  }

  stop() {
    this.controller?.abort();
  }

  /** Resolves when the run ends (completed, stopped, or failed). */
  async start(form: Pick<GeneratorForm, "mode" | "events" | "ratePerSecond">): Promise<void> {
    if (this.isRunning) return;
    const { send, sleep, now, uuid, random } = this.deps;
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;

    const runId = uuid();
    const plan = planRun({ mode: form.mode, count: form.events, now: now(), random, uuid });
    const interval = sendIntervalMs(form.ratePerSecond);
    this.update({
      ...IDLE_STATE,
      status: "running",
      runId,
      mode: form.mode,
      planned: plan.length,
      startedAt: now(),
    });

    let nextAt = now();
    let failure: string | null = null;

    for (const planned of plan) {
      const wait = nextAt - now();
      if (wait > 0) await sleep(wait, signal);
      if (signal.aborted) break;
      // Drift-corrected schedule: a late timer does not push later sends back. When we are more
      // than one interval behind (slow responses, retries) we resync instead of catching up, so
      // sends are never closer together than the interval and the rate never exceeds the setting.
      const startedAt = now();
      nextAt += interval;
      if (nextAt < startedAt) nextAt = startedAt + interval;

      // Built once: retries resend this exact payload, event ids included.
      const body: IngestRequest = { events: [buildEvent(planned, { now: now(), uuid })], runId };
      let attempt = 0;
      for (;;) {
        try {
          const ack = await send(body);
          const first = ack.acks[0];
          this.update({
            accepted: this.state.accepted + ack.accepted,
            lastAck: first ? { partition: first.partition, baseOffset: first.baseOffset } : this.state.lastAck,
          });
          break;
        } catch (cause) {
          if (signal.aborted) break;
          const error = cause instanceof ApiError ? cause : null;
          if (error?.retryable && attempt < MAX_RETRIES) {
            this.update({ retries: this.state.retries + 1 });
            await sleep(retryDelayMs(attempt, error), signal);
            attempt += 1;
            if (signal.aborted) break;
            continue;
          }
          failure = error ? `${error.message} (${error.code})` : cause instanceof Error ? cause.message : "Request failed.";
          this.update({ failed: this.state.failed + body.events.length });
          break;
        }
      }
      if (failure || signal.aborted) break;
    }

    this.controller = null;
    this.update({
      status: failure ? "failed" : signal.aborted ? "stopped" : "completed",
      error: failure,
      finishedAt: now(),
    });
  }
}
