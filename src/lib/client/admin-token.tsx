"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { AdminVerifyData } from "@/shared/api";
import { ApiError, apiRequest } from "./api";

/**
 * The admin token lives in React state and nowhere else: not in localStorage, sessionStorage,
 * cookies, the URL, or source code. Reloading the page clears it.
 */
interface AdminTokenContextValue {
  isUnlocked: boolean;
  /**
   * Verifies the token with the server and keeps it only if the server accepts it. If `signal` is
   * aborted (the dialog was dismissed), the token is discarded even if the server said yes, and the
   * promise rejects with an AbortError.
   */
  unlock: (token: string, signal?: AbortSignal) => Promise<void>;
  /** Forget the token. `reason` is shown to the user (e.g. after a 401). */
  lock: (reason?: string) => void;
  /** Message explaining why the token was cleared, if the server rejected it. */
  lockReason: string | null;
  /** POST with the admin bearer token. A 401 clears the token and rethrows. */
  adminPost: <T>(path: string, body?: unknown) => Promise<T>;
  dialogOpen: boolean;
  openDialog: () => void;
  setDialogOpen: (open: boolean) => void;
}

const AdminTokenContext = createContext<AdminTokenContextValue | null>(null);

export function AdminTokenProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [lockReason, setLockReason] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const lock = useCallback((reason?: string) => {
    setToken(null);
    setLockReason(reason ?? null);
  }, []);

  const unlock = useCallback(async (candidate: string, signal?: AbortSignal) => {
    await apiRequest<AdminVerifyData>("/api/admin/verify", { method: "POST", token: candidate, body: {}, signal });
    if (signal?.aborted) throw new DOMException("Verification was cancelled.", "AbortError");
    setToken(candidate);
    setLockReason(null);
  }, []);

  const adminPost = useCallback(
    async <T,>(path: string, body: unknown = {}): Promise<T> => {
      if (!token) {
        throw new ApiError({ status: 401, code: "unauthorized", message: "Enter the admin token first." });
      }
      try {
        return await apiRequest<T>(path, { method: "POST", token, body });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          lock("The server rejected the admin token, so it was cleared. Enter it again to continue.");
        }
        throw error;
      }
    },
    [token, lock],
  );

  const value = useMemo<AdminTokenContextValue>(
    () => ({
      isUnlocked: token !== null,
      unlock,
      lock,
      lockReason,
      adminPost,
      dialogOpen,
      openDialog: () => setDialogOpen(true),
      setDialogOpen,
    }),
    [token, unlock, lock, lockReason, adminPost, dialogOpen],
  );

  return <AdminTokenContext.Provider value={value}>{children}</AdminTokenContext.Provider>;
}

export function useAdmin(): AdminTokenContextValue {
  const context = useContext(AdminTokenContext);
  if (!context) throw new Error("useAdmin must be used inside <AdminTokenProvider>");
  return context;
}
