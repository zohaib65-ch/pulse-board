"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { DEFAULT_RANGE, RANGE_KEYS, type RangeKey } from "@/shared/constants";
import { createLocalPreference } from "./local-preference";

const rangePreference = createLocalPreference<RangeKey>("pulseboard-range", RANGE_KEYS, DEFAULT_RANGE);

interface RangeContextValue {
  range: RangeKey;
  setRange: (range: RangeKey) => void;
}

const RangeContext = createContext<RangeContextValue | null>(null);

/** The one time-range filter shared by Overview, Live Events and Products. */
export function RangeProvider({ children }: { children: React.ReactNode }) {
  const range = useSyncExternalStore(rangePreference.subscribe, rangePreference.getSnapshot, rangePreference.getServerSnapshot);
  const setRange = useCallback((next: RangeKey) => rangePreference.set(next), []);
  const value = useMemo(() => ({ range, setRange }), [range, setRange]);
  return <RangeContext.Provider value={value}>{children}</RangeContext.Provider>;
}

export function useRange(): RangeContextValue {
  const context = useContext(RangeContext);
  if (!context) throw new Error("useRange must be used inside <RangeProvider>");
  return context;
}
