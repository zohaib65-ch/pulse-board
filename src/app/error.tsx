"use client";

import Link from "next/link";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Error boundary for everything below the root layout. It renders inside the layout, so the
 * providers (theme, range filter, in-memory admin token) are not reset by an ordinary render error.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl space-y-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>This page failed to render</AlertTitle>
        <AlertDescription>
          <p>The page hit an unexpected error, so it could not be shown. Your data is not affected. Try again, or go back to the overview.</p>
          {error.digest ? <p className="mt-2 font-mono text-xs">Reference: {error.digest}</p> : null}
        </AlertDescription>
      </Alert>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={reset}>
          <RefreshCw /> Try again
        </Button>
        <Button asChild variant="outline">
          <Link href="/">Back to overview</Link>
        </Button>
      </div>
    </div>
  );
}
