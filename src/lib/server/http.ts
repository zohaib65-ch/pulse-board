import { MongoNetworkError, MongoServerSelectionError } from "mongodb";
import type { z } from "zod";
import type { ApiResponse } from "@/shared/api";
import { ApiError, ConfigError, errorMessage } from "./errors";
import { log } from "./log";

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export function ok<T>(data: T, status = 200): Response {
  const body: ApiResponse<T> = { ok: true, data };
  return Response.json(body, { status, headers: BASE_HEADERS });
}

export function fail(error: ApiError): Response {
  const body: ApiResponse<never> = {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.issues ? { issues: error.issues } : {}),
      ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    },
  };
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (error.retryAfterSeconds !== undefined) headers["Retry-After"] = String(error.retryAfterSeconds);
  if (error.status === 401) headers["WWW-Authenticate"] = 'Bearer realm="pulseboard-admin"';
  return Response.json(body, { status: error.status, headers });
}

/** Maps any thrown error to a consistent JSON response without leaking internals. */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) return fail(error);
  if (error instanceof ConfigError) {
    // Variable names only, never values.
    log.error("configuration error", { variables: error.variables });
    return fail(new ApiError(503, "server_misconfigured", "The server configuration is incomplete."));
  }
  if (error instanceof MongoServerSelectionError || error instanceof MongoNetworkError) {
    log.error("database unavailable", { error: errorMessage(error) });
    return fail(new ApiError(503, "database_unavailable", "The database is unreachable. Try again shortly."));
  }
  log.error("unhandled error", { error: errorMessage(error) });
  return fail(new ApiError(500, "internal_error", "Something went wrong on the server."));
}

/** Wraps a Route Handler so every failure becomes a typed JSON error. */
export function route(handler: (request: Request) => Promise<Response>): (request: Request) => Promise<Response>;
export function route<C>(
  handler: (request: Request, context: C) => Promise<Response>,
): (request: Request, context: C) => Promise<Response>;
export function route<C>(handler: (request: Request, context: C) => Promise<Response>) {
  return async (request: Request, context: C): Promise<Response> => {
    try {
      return await handler(request, context);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

function zodIssues(error: z.ZodError) {
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(String).join(".") || "(root)",
    message: issue.message,
  }));
}

export function invalid(message: string, error?: z.ZodError): ApiError {
  return new ApiError(400, "invalid_request", message, error ? { issues: zodIssues(error) } : {});
}

/** Validates the query string against a strict schema (unknown parameters are rejected). */
export function parseQuery<S extends z.ZodType>(request: Request, schema: S): z.output<S> {
  const params = new URL(request.url).searchParams;
  const raw: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key in raw) throw invalid(`Query parameter "${key}" was provided more than once.`);
    raw[key] = value;
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw invalid("Invalid query parameters.", result.error);
  return result.data;
}

/** Reads a request body as text, refusing anything larger than `maxBytes` (even without Content-Length). */
async function readLimitedText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError(413, "payload_too_large", `Request body must be at most ${maxBytes} bytes.`);
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError(413, "payload_too_large", `Request body must be at most ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
  maxBytes: number,
): Promise<z.output<S>> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) {
    throw invalid("Content-Type must be application/json.");
  }
  const text = await readLimitedText(request, maxBytes);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw invalid("Request body is not valid JSON.");
  }
  const result = schema.safeParse(json);
  if (!result.success) throw invalid("Invalid request body.", result.error);
  return result.data;
}
