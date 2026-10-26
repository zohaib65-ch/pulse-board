"use client";

import { Lock, LockOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAdmin } from "@/lib/client/admin-token";

/** Header control showing the real lock state; opens the Admin access dialog. */
export function AdminButton() {
  const { isUnlocked, openDialog } = useAdmin();
  return (
    <Button type="button" variant="outline" size="sm" className="touch:min-w-11" onClick={openDialog} aria-label={isUnlocked ? "Admin unlocked. Open admin access" : "Admin locked. Open admin access"}>
      {isUnlocked ? <LockOpen className="text-success" /> : <Lock />}
      <span className="hidden sm:inline">{isUnlocked ? "Admin unlocked" : "Admin locked"}</span>
    </Button>
  );
}

/** Inline prompt shown next to write actions while the token is missing. */
export function AdminRequired({ id, children = "This action needs the admin token." }: { id?: string; children?: React.ReactNode }) {
  const { isUnlocked, openDialog } = useAdmin();
  if (isUnlocked) return null;
  return (
    <div id={id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-dashed bg-muted/40 px-3 py-2 text-sm">
      <Lock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 text-muted-foreground">{children}</span>
      <Button type="button" size="sm" variant="outline" onClick={openDialog}>
        Enter token
      </Button>
    </div>
  );
}
