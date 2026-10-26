"use client";

import { useCallback, useState } from "react";

/**
 * State that belongs to one key and starts over from `initialValue` whenever the key changes,
 * including when it changes back to a value it had before (a plain "derive if the key matches"
 * would bring the old state back). `initialValue` must be a stable reference.
 *
 * It uses React's "adjust state while rendering" pattern, so the reset is applied before anything
 * is committed or fetched: no frame ever shows the old state under the new key.
 */
export function useKeyedState<T>(key: string, initialValue: T): [T, (next: T | ((current: T) => T)) => void] {
  const [state, setState] = useState({ key, value: initialValue });
  let current = state;
  if (state.key !== key) {
    current = { key, value: initialValue };
    setState(current);
  }
  const set = useCallback(
    (next: T | ((current: T) => T)) =>
      setState((previous) => {
        const base = previous.key === key ? previous.value : initialValue;
        return { key, value: typeof next === "function" ? (next as (current: T) => T)(base) : next };
      }),
    [key, initialValue],
  );
  return [current.value, set];
}
