/**
 * Tiny external store for a per-viewer preference kept in localStorage (theme, range filter).
 * It is a convenience only: every read and write is wrapped in try/catch, and the app renders
 * correctly with storage blocked or empty. Never use it for secrets or for state that must persist.
 */
export interface LocalPreference<T extends string> {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => T;
  getServerSnapshot: () => T;
  set: (next: T) => void;
}

export function createLocalPreference<T extends string>(
  storageKey: string,
  allowed: readonly T[],
  fallback: T,
): LocalPreference<T> {
  let value: T | null = null;
  const listeners = new Set<() => void>();

  const read = (): T => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored && (allowed as readonly string[]).includes(stored)) return stored as T;
    } catch {
      // storage unavailable (private window, blocked site data): fall through to the default
    }
    return fallback;
  };

  const notify = () => listeners.forEach((listener) => listener());

  return {
    subscribe(listener) {
      listeners.add(listener);
      const onStorage = (event: StorageEvent) => {
        if (event.key === storageKey) {
          value = read();
          listener();
        }
      };
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", onStorage);
      };
    },
    getSnapshot() {
      if (value === null) value = read();
      return value;
    },
    getServerSnapshot: () => fallback,
    set(next) {
      value = next;
      try {
        window.localStorage.setItem(storageKey, next);
      } catch {
        // ignore: the in-memory value still applies for this page view
      }
      notify();
    },
  };
}
