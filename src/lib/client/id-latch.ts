/**
 * A set of ids that only ever grows. `useSyncExternalStore`-compatible.
 *
 * Used to confirm that events were processed: once an event id has been seen in the stored events
 * it stays confirmed, whatever later requests return (a flaky read, a time window moving on, or
 * newer events pushing it out of a list must never turn it back into "not processed").
 */
export class IdLatch {
  private ids = new Set<string>();
  private snapshot: ReadonlySet<string> = new Set();
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** A new object each time the set grows, so React sees the change; the same object otherwise. */
  getSnapshot = (): ReadonlySet<string> => this.snapshot;

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(ids: Iterable<string>) {
    let changed = false;
    for (const id of ids) {
      if (!this.ids.has(id)) {
        this.ids.add(id);
        changed = true;
      }
    }
    if (changed) {
      this.snapshot = new Set(this.ids);
      this.listeners.forEach((listener) => listener());
    }
  }
}
