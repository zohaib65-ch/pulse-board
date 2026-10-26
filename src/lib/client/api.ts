import type { ApiErrorBody, ApiResponse, ErrorCode } from "@/shared/api";

export type ClientErrorCode = ErrorCode | "network" | "bad_response";

/** Every failed request surfaces as an ApiError carrying the server's code and message. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly issues?: ApiErrorBody["issues"];
  readonly retryAfterSeconds?: number;

  constructor(init: {
    status: number;
    code: ClientErrorCode;
    message: string;
    issues?: ApiErrorBody["issues"];
    retryAfterSeconds?: number;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.issues = init.issues;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }

  /**
   * Worth resending the same payload: no connection, a transient 503 (Kafka or database down), or a
   * rate limit that clears within `MAX_RETRYABLE_RATE_LIMIT_SECONDS` (a fixed-window collision).
   * 400/401/413, `server_misconfigured`, and longer rate limits are terminal.
   */
  get retryable(): boolean {
    if (this.code === "network") return true;
    if (this.status === 429) return this.retryAfterSeconds !== undefined && this.retryAfterSeconds <= MAX_RETRYABLE_RATE_LIMIT_SECONDS;
    return this.status === 503 && this.code !== "server_misconfigured";
  }
}

/** A 429 asking us to wait at most this long is a harmless window collision, not a real limit. */
export const MAX_RETRYABLE_RATE_LIMIT_SECONDS = 2;

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Admin bearer token. Sent only in the Authorization header; never logged or stored here. */
  token?: string | null;
  signal?: AbortSignal;
}

/** Same-origin relative request returning the unwrapped `data` of an ApiResponse envelope. */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, token, signal } = options;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      cache: "no-store",
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new ApiError({
      status: 0,
      code: "network",
      message: "Could not reach the server. Check your connection and try again.",
    });
  }

  let payload: ApiResponse<T> | null = null;
  try {
    payload = (await response.json()) as ApiResponse<T>;
  } catch {
    payload = null;
  }

  if (payload && typeof payload === "object" && "ok" in payload) {
    if (payload.ok) return payload.data;
    const retryHeader = Number(response.headers.get("Retry-After"));
    throw new ApiError({
      status: response.status,
      code: payload.error.code,
      message: payload.error.message,
      issues: payload.error.issues,
      retryAfterSeconds: payload.error.retryAfterSeconds ?? (Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : undefined),
    });
  }

  throw new ApiError({
    status: response.status,
    code: "bad_response",
    message: `The server returned an unexpected response (HTTP ${response.status}).`,
  });
}

export const apiGet = <T>(path: string, signal?: AbortSignal) => apiRequest<T>(path, { signal });

/** Builds `?a=1&b=2`, skipping undefined/null/empty values. */
export function queryString(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
