import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLLING } from "@/shared/constants";
import { ApiError, apiRequest, queryString } from "@/lib/client/api";
import { IdLatch } from "@/lib/client/id-latch";
import { nextDelayMs, Poller } from "@/lib/client/poller";
import { describeKafkaPublish, RECENT_PUBLISH_MS, withStaleness } from "@/lib/client/status";
import { eventsQueryString } from "@/lib/client/hooks";
import { formatAge, formatWhen } from "@/lib/format";

/** Minimal `document` so the framework-free poller can be driven without a browser. */
function fakeDocument() {
  const listeners = new Set<() => void>();
  const doc = {
    hidden: false,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    setHidden(value: boolean) {
      doc.hidden = value;
      listeners.forEach((fn) => fn());
    },
  };
  return doc;
}

let doc: ReturnType<typeof fakeDocument>;
beforeEach(() => {
  vi.useFakeTimers();
  doc = fakeDocument();
  vi.stubGlobal("document", doc);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const serverError = () => new ApiError({ status: 503, code: "database_unavailable", message: "db down" });

function setup<T>(fetcher: (signal: AbortSignal) => Promise<T>, overrides: { key?: string; paused?: boolean } = {}) {
  const poller = new Poller<T>();
  poller.configure({ key: overrides.key ?? "a", fetcher, intervalMs: POLLING.intervalMs, paused: overrides.paused ?? false });
  poller.start();
  return poller;
}

describe("polling", () => {
  it("refreshes about every five seconds", async () => {
    const fetcher = vi.fn(async () => "ok");
    const poller = setup(fetcher);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLLING.intervalMs);
    await vi.advanceTimersByTimeAsync(POLLING.intervalMs);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(poller.getSnapshot()).toMatchObject({ data: "ok", error: null, failures: 0 });
    poller.stop();
  });

  it("never overlaps requests, even when a response is slower than the interval", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetcher = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, POLLING.intervalMs * 3));
      inFlight--;
      return "slow";
    });
    const poller = setup(fetcher);
    await vi.advanceTimersByTimeAsync(POLLING.intervalMs * 10);
    poller.refresh(); // a manual refresh while one is running is ignored
    poller.refresh();
    expect(maxInFlight).toBe(1);
    poller.stop();
  });

  it("pauses in a hidden tab, aborts the in-flight request, and refreshes when visible again", async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn(async (signal: AbortSignal) => {
      signals.push(signal);
      return "ok";
    });
    const poller = setup(fetcher);
    await vi.advanceTimersByTimeAsync(0);
    doc.setHidden(true);
    await vi.advanceTimersByTimeAsync(POLLING.intervalMs * 6);
    expect(fetcher).toHaveBeenCalledTimes(1); // nothing while hidden
    doc.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2); // immediate refresh on return
    poller.stop();
  });

  it("backs off after errors, keeps the old data, and recovers", async () => {
    let fail = false;
    const fetcher = vi.fn(async () => {
      if (fail) throw serverError();
      return "fresh";
    });
    const poller = setup(fetcher);
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getSnapshot().data).toBe("fresh");

    fail = true;
    await vi.advanceTimersByTimeAsync(POLLING.intervalMs); // failure #1
    expect(poller.getSnapshot()).toMatchObject({ data: "fresh", failures: 1 });
    expect(poller.getSnapshot().error?.code).toBe("database_unavailable");
    const callsAfterFirstFailure = fetcher.mock.calls.length;

    // The next attempt waits the (longer) backoff, not the normal 5 s interval.
    await vi.advanceTimersByTimeAsync(POLLING.intervalMs);
    expect(fetcher.mock.calls.length).toBe(callsAfterFirstFailure);
    await vi.advanceTimersByTimeAsync(POLLING.backoffBaseMs);
    expect(poller.getSnapshot().failures).toBe(2);

    fail = false;
    await vi.advanceTimersByTimeAsync(POLLING.backoffMaxMs);
    expect(poller.getSnapshot()).toMatchObject({ data: "fresh", error: null, failures: 0 });
    poller.stop();
  });

  it("computes exponential backoff capped at the maximum, and honours Retry-After", () => {
    expect(nextDelayMs(0, 5000)).toBe(5000);
    expect(nextDelayMs(1, 5000)).toBe(POLLING.backoffBaseMs);
    expect(nextDelayMs(2, 5000)).toBe(POLLING.backoffBaseMs * 2);
    expect(nextDelayMs(20, 5000)).toBe(POLLING.backoffMaxMs);
    expect(nextDelayMs(1, 5000, 120)).toBe(120_000);
  });

  it("a paused display stops interval refreshes but a filter change still loads once", async () => {
    const fetcher = vi.fn(async () => "ok");
    const poller = setup(fetcher, { paused: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLLING.intervalMs * 5);
    expect(fetcher).toHaveBeenCalledTimes(1);
    poller.configure({ key: "b", fetcher, intervalMs: POLLING.intervalMs, paused: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(poller.getSnapshot().dataKey).toBe("b");
    poller.stop();
  });
});

describe("pause display", () => {
  const config = <T,>(fetcher: (signal: AbortSignal) => Promise<T>, paused: boolean, key = "a") => ({
    key,
    fetcher,
    intervalMs: POLLING.intervalMs,
    paused,
  });

  it("ignores the tab becoming visible again, so a frozen list is not replaced", async () => {
    let value = 1;
    const fetcher = vi.fn(async () => value++);
    const poller = setup(fetcher, { paused: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getSnapshot().data).toBe(1);

    doc.setHidden(true);
    doc.setHidden(false);
    await vi.advanceTimersByTimeAsync(POLLING.intervalMs * 3);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(poller.getSnapshot().data).toBe(1);
    poller.stop();
  });

  it("still loads when the tab returns if nothing has loaded for the current key yet", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      if (++calls === 1) throw serverError();
      return "late";
    });
    const poller = setup(fetcher, { paused: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getSnapshot().data).toBeNull();
    doc.setHidden(true);
    doc.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getSnapshot().data).toBe("late");
    poller.stop();
  });

  it("does not run backoff retries while paused", async () => {
    let fail = false;
    const fetcher = vi.fn(async () => {
      if (fail) throw serverError();
      return "frozen";
    });
    const poller = setup(fetcher);
    await vi.advanceTimersByTimeAsync(0);
    fail = true;
    await vi.advanceTimersByTimeAsync(POLLING.intervalMs); // failure #1, a backoff retry is now scheduled
    expect(poller.getSnapshot().failures).toBe(1);
    const calls = fetcher.mock.calls.length;

    poller.configure(config(fetcher, true)); // the user pauses the display
    fail = false; // the server recovers, but the paused display must not pick that up
    await vi.advanceTimersByTimeAsync(POLLING.backoffMaxMs * 3);
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(poller.getSnapshot().data).toBe("frozen");
    poller.stop();
  });

  it("refreshes immediately when un-paused instead of waiting a full interval", async () => {
    let value = 0;
    const fetcher = vi.fn(async () => ++value);
    const poller = setup(fetcher, { paused: true });
    await vi.advanceTimersByTimeAsync(POLLING.intervalMs * 4);
    expect(fetcher).toHaveBeenCalledTimes(1);

    poller.configure(config(fetcher, false));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(poller.getSnapshot().data).toBe(2);
    // ...and normal interval refreshing resumes.
    await vi.advanceTimersByTimeAsync(POLLING.intervalMs);
    expect(fetcher).toHaveBeenCalledTimes(3);
    poller.stop();
  });

  it("an explicit refresh() loads once while paused and does not start a schedule", async () => {
    const fetcher = vi.fn(async () => "ok");
    const poller = setup(fetcher, { paused: true });
    await vi.advanceTimersByTimeAsync(0);
    poller.refresh();
    await vi.advanceTimersByTimeAsync(POLLING.intervalMs * 5);
    expect(fetcher).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("a failed load while paused is not retried automatically", async () => {
    const fetcher = vi.fn(async () => {
      throw serverError();
    });
    const poller = setup(fetcher, { paused: true });
    await vi.advanceTimersByTimeAsync(POLLING.backoffMaxMs * 3);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(poller.getSnapshot().error?.code).toBe("database_unavailable");
    poller.stop();
  });
});

describe("refresh while a request is in flight", () => {
  it("queues exactly one follow-up, however many times it is called", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const gate: { release: () => void }[] = [];
    const fetcher = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          gate.push({
            release: () => {
              inFlight--;
              resolve("ok");
            },
          });
        }),
    );
    const poller = setup(fetcher);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    poller.refresh();
    poller.refresh();
    poller.refresh();
    expect(fetcher).toHaveBeenCalledTimes(1); // still the original request

    gate[0]!.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2); // exactly one follow-up
    gate[1]!.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    poller.stop();
  });
});

describe("keys", () => {
  it("a failure belongs to the key that failed and is cleared when the key changes", async () => {
    const failing = vi.fn(async (): Promise<string> => {
      throw serverError();
    });
    const poller = setup(failing, { key: "a" });
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getSnapshot()).toMatchObject({ errorKey: "a", failures: 1 });

    const fine = vi.fn(async () => "b-data");
    poller.configure({ key: "b", fetcher: fine, intervalMs: POLLING.intervalMs, paused: false });
    expect(poller.getSnapshot()).toMatchObject({ error: null, errorKey: null, failures: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getSnapshot()).toMatchObject({ data: "b-data", dataKey: "b", error: null });
    poller.stop();
  });
});

describe("api client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the admin token only in the Authorization header", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { verified: true } }));
    vi.stubGlobal("fetch", fetchMock);
    await apiRequest("/api/admin/verify", { method: "POST", body: {}, token: "secret-token-value" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/admin/verify"); // relative, same-origin, no token in the URL
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token-value");
    expect(JSON.stringify(init.body)).not.toContain("secret-token-value");
  });

  it("turns error envelopes, rate limits, and garbage responses into typed errors", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ ok: false, error: { code: "rate_limited", message: "slow down", retryAfterSeconds: 2 } }, { status: 429 }),
    );
    await expect(apiRequest("/x")).rejects.toMatchObject({ code: "rate_limited", status: 429, retryAfterSeconds: 2, retryable: true });
    vi.stubGlobal("fetch", async () => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(apiRequest("/x")).rejects.toMatchObject({ code: "bad_response" });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(apiRequest("/x")).rejects.toMatchObject({ code: "network", retryable: true });
  });

  it("builds query strings without empty values", () => {
    expect(queryString({ a: 1, b: "", c: null, d: undefined, e: "x y" })).toBe("?a=1&e=x+y");
    expect(queryString({})).toBe("");
  });
});

describe("processed-event latch", () => {
  it("only ever grows: a confirmed id stays confirmed", () => {
    const latch = new IdLatch();
    const seen: ReadonlySet<string>[] = [];
    latch.subscribe(() => seen.push(latch.getSnapshot()));

    latch.add(["a", "b"]);
    const afterFirst = latch.getSnapshot();
    expect([...afterFirst].sort()).toEqual(["a", "b"]);

    latch.add(["a"]); // nothing new: same snapshot, no re-render
    expect(latch.getSnapshot()).toBe(afterFirst);
    expect(seen).toHaveLength(1);

    latch.add([]); // a later lookup that returns nothing cannot revert anything
    expect(latch.has("a")).toBe(true);
    expect(latch.has("b")).toBe(true);

    latch.add(["c"]);
    expect([...latch.getSnapshot()].sort()).toEqual(["a", "b", "c"]);
    expect(afterFirst.has("c")).toBe(false); // earlier snapshots are not mutated
  });

  it("looks events up by id", () => {
    const query = eventsQueryString({ range: "1h", ids: ["id-1", "id-2"] });
    expect(new URLSearchParams(query).get("ids")).toBe("id-1,id-2");
    expect(eventsQueryString({ range: "1h" })).not.toContain("ids");
  });
});

describe("status honesty", () => {
  const now = new Date(2026, 9, 26, 12, 0, 0).getTime(); // local noon, so "today" is the same in every timezone
  const kafka = (lastPublishAt: string | null, lastPublishError: { at: string; message: string } | null = null) => ({
    topic: "website-events",
    partitions: 2,
    lastPublishAt,
    lastPublishError,
    workerConnected: true,
  });

  it("calls a publish healthy only when it is recent", () => {
    const recent = describeKafkaPublish(kafka(new Date(now - 30_000).toISOString()), now);
    expect(recent.tone).toBe("ok");
    expect(recent.label).toBe("Last publish 30s ago");

    const old = describeKafkaPublish(kafka(new Date(now - 15 * 60_000).toISOString()), now);
    expect(old).toEqual({ label: "Last publish 15m ago", tone: "unknown" });
    expect(Date.parse(new Date(now - RECENT_PUBLISH_MS - 1000).toISOString())).toBeLessThan(now - RECENT_PUBLISH_MS);
    expect(describeKafkaPublish(kafka(new Date(now - RECENT_PUBLISH_MS - 1000).toISOString()), now).tone).toBe("unknown");
  });

  it("reports a failure that is newer than the last success, and no publish at all", () => {
    const failed = describeKafkaPublish(kafka(new Date(now - 60_000).toISOString(), { at: new Date(now - 5000).toISOString(), message: "broker down" }), now);
    expect(failed).toEqual({ label: "Last publish failed", tone: "bad" });
    // An old failure followed by a newer success is not a current failure.
    const recovered = describeKafkaPublish(kafka(new Date(now - 5000).toISOString(), { at: new Date(now - 60_000).toISOString(), message: "old" }), now);
    expect(recovered.tone).toBe("ok");
    expect(describeKafkaPublish(kafka(null), now)).toEqual({ label: "No publish yet", tone: "unknown" });
  });

  it("turns any badge neutral when the status request is stale", () => {
    expect(withStaleness({ label: "Connected", tone: "ok" }, true)).toEqual({ label: "Unknown · last known: Connected", tone: "unknown" });
    expect(withStaleness({ label: "Connected", tone: "ok" }, false)).toEqual({ label: "Connected", tone: "ok" });
  });

  it("shows the date for anything that is not from today", () => {
    const today = new Date(now - 3600_000).toISOString();
    const yesterday = new Date(now - 26 * 3600_000).toISOString();
    expect(formatWhen(today, now)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(formatWhen(yesterday, now)).toMatch(/[A-Z][a-z]{2}/); // includes a month name
    expect(formatAge(new Date(now - 3 * 60_000).toISOString(), now)).toBe("3m");
  });
});
