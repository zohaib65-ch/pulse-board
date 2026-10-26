"use client";

import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AdminAccessDialog } from "./admin-access-dialog";
import { AdminButton } from "./admin-button";
import { AppSidebar } from "./app-sidebar";
import { ThemeToggle } from "./theme-toggle";

/** Sidebar + compact header around every page. Pages render their own title (h1). */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset id="main" tabIndex={-1} className="min-w-0 outline-none">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 md:px-6">
          <SidebarTrigger aria-label="Toggle navigation" className="-ml-1" />
          <Separator orientation="vertical" className="mx-1 h-5" />
          <span className="text-sm font-semibold tracking-tight md:hidden">Pulseboard</span>
          <div className="ml-auto flex items-center gap-2">
            <AdminButton />
            <ThemeToggle />
          </div>
        </header>
        <div className="mx-auto w-full min-w-0 max-w-[1440px] flex-1 px-4 py-6 md:px-8 md:py-8">{children}</div>
      </SidebarInset>
      <AdminAccessDialog />
    </SidebarProvider>
  );
}
