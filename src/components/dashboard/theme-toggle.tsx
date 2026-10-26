"use client";

import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/client/theme-provider";

/** Quick light/dark switch for the header. Light, Dark and System live in Settings. */
export function ThemeToggle() {
  const { resolved, setPreference } = useTheme();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Switch between light and dark theme"
      onClick={() => setPreference(resolved === "dark" ? "light" : "dark")}
    >
      <Sun className="hidden dark:block" />
      <Moon className="dark:hidden" />
    </Button>
  );
}
