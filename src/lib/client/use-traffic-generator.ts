"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { IngestData } from "@/shared/api";
import { useAdmin } from "./admin-token";
import { TrafficGenerator, type GeneratorForm } from "./traffic-generator";

/**
 * Owns one TrafficGenerator for the Lab page. The run is stopped when the page unmounts or is
 * hidden by Activity, so no timers keep sending events in the background.
 */
export function useTrafficGenerator() {
  const { adminPost } = useAdmin();
  const [generator] = useState(
    () =>
      new TrafficGenerator({
        send: () => Promise.reject(new Error("Admin token not ready")),
      }),
  );
  const state = useSyncExternalStore(generator.subscribe, generator.getSnapshot, generator.getSnapshot);

  useEffect(() => {
    generator.setSender((body) => adminPost<IngestData>("/api/events", body));
  }, [generator, adminPost]);

  useEffect(() => () => generator.stop(), [generator]);

  return {
    state,
    start: (form: Pick<GeneratorForm, "mode" | "events" | "ratePerSecond">) => void generator.start(form),
    stop: () => generator.stop(),
  };
}
