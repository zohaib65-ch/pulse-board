"use client";

import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { KeyRound, LockOpen, ShieldCheck } from "lucide-react";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useAdmin } from "@/lib/client/admin-token";
import { ApiError } from "@/lib/client/api";
import { zodResolver } from "@/lib/client/zod-resolver";

const tokenSchema = z.object({
  token: z.string().trim().min(1, "Enter the admin token").max(256, "That token is too long"),
});
type TokenForm = z.infer<typeof tokenSchema>;

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "The server did not accept that token.";
    if (error.status === 429 && error.retryAfterSeconds) return `${error.message} Try again in ${error.retryAfterSeconds}s.`;
    return error.message;
  }
  return "Could not verify the token.";
}

/** The verification in flight, if any. Dismissing the dialog cancels it. */
class Verification {
  private controller: AbortController | null = null;

  begin(): AbortController {
    this.cancel();
    this.controller = new AbortController();
    return this.controller;
  }

  finish(controller: AbortController) {
    if (this.controller === controller) this.controller = null;
  }

  cancel() {
    this.controller?.abort();
    this.controller = null;
  }
}

/** Small dialog for entering ADMIN_TOKEN. The token is verified by the server and kept in memory only. */
export function AdminAccessDialog() {
  const { isUnlocked, unlock, lock, lockReason, dialogOpen, setDialogOpen } = useAdmin();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<TokenForm>({ resolver: zodResolver(tokenSchema), defaultValues: { token: "" } });
  // Dismissing the dialog aborts the verification in flight, so a late "yes" from the server
  // cannot unlock the app after the user has backed out.
  const [verification] = useState(() => new Verification());

  const onOpenChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      verification.cancel();
      form.reset();
      setServerError(null);
    }
  };

  const onSubmit = form.handleSubmit(async ({ token }) => {
    setServerError(null);
    const controller = verification.begin();
    try {
      await unlock(token, controller.signal);
      if (controller.signal.aborted) return;
      form.reset();
      setDialogOpen(false);
    } catch (error) {
      if (controller.signal.aborted) return; // dismissed: nothing to report
      setServerError(describe(error));
    } finally {
      verification.finish(controller);
    }
  });

  return (
    <Dialog open={dialogOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isUnlocked ? <LockOpen className="size-4 text-success" aria-hidden /> : <KeyRound className="size-4" aria-hidden />}
            Admin access
          </DialogTitle>
          <DialogDescription>
            {isUnlocked
              ? "Admin controls are unlocked in this tab. Sending events, pausing consumers and starting replays are enabled."
              : "Sending events, pausing consumers and starting replays need the ADMIN_TOKEN configured on the server."}
          </DialogDescription>
        </DialogHeader>

        {isUnlocked ? (
          <>
            <Alert>
              <ShieldCheck />
              <AlertTitle>Unlocked</AlertTitle>
              <AlertDescription>The token is held in this tab&apos;s memory only. Reloading the page clears it.</AlertDescription>
            </Alert>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => lock()}>
                Clear token
              </Button>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={onSubmit} noValidate className="grid gap-4">
            {lockReason ? (
              <Alert variant="destructive">
                <AlertDescription>{lockReason}</AlertDescription>
              </Alert>
            ) : null}
            <Controller
              control={form.control}
              name="token"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || serverError !== null}>
                  <FieldLabel htmlFor="admin-token">Admin token</FieldLabel>
                  <Input
                    {...field}
                    id="admin-token"
                    type="password"
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    aria-invalid={fieldState.invalid || serverError !== null}
                    aria-describedby="admin-token-help admin-token-error"
                  />
                  <FieldDescription id="admin-token-help">Held in this tab&apos;s memory only. It is never saved, and reloading clears it.</FieldDescription>
                  <div id="admin-token-error">
                    <FieldError errors={[fieldState.error]}>{serverError}</FieldError>
                  </div>
                </Field>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Verifying…" : "Unlock"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
