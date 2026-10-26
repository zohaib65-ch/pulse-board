"use client";

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { createLocalPreference } from "./local-preference";
import { THEME_STORAGE_KEY } from "./theme-script";

export const THEME_OPTIONS = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEME_OPTIONS)[number];

const themePreference = createLocalPreference<ThemePreference>(THEME_STORAGE_KEY, THEME_OPTIONS, "system");

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribeSystem(listener: () => void) {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
const getSystemDark = () => window.matchMedia(DARK_QUERY).matches;

function applyTheme(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

interface ThemeContextValue {
  preference: ThemePreference;
  /** What is actually applied right now. */
  resolved: "light" | "dark";
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const preference = useSyncExternalStore(themePreference.subscribe, themePreference.getSnapshot, themePreference.getServerSnapshot);
  const systemDark = useSyncExternalStore(subscribeSystem, getSystemDark, () => false);
  const dark = preference === "dark" || (preference === "system" && systemDark);

  useEffect(() => {
    applyTheme(dark);
  }, [dark]);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved: dark ? "dark" : "light", setPreference: themePreference.set }),
    [preference, dark],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside <ThemeProvider>");
  return context;
}
