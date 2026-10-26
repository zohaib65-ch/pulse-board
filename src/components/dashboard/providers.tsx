"use client";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AdminTokenProvider } from "@/lib/client/admin-token";
import { RangeProvider } from "@/lib/client/range-provider";
import { ThemeProvider } from "@/lib/client/theme-provider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <RangeProvider>
        <AdminTokenProvider>
          <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
        </AdminTokenProvider>
      </RangeProvider>
    </ThemeProvider>
  );
}
