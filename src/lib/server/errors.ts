import type { ErrorCode } from "@/shared/api";

/** An error that maps directly to an HTTP response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly issues?: { path: string; message: string }[];
  readonly retryAfterSeconds?: number;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    extra: { issues?: { path: string; message: string }[]; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = extra.issues;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}

/**
 * Missing or malformed environment configuration. Carries variable NAMES only; values
 * (which may be credentials) are never included.
 */
export class ConfigError extends Error {
  readonly variables: string[];

  constructor(variables: string[], details: string[]) {
    super(`Invalid configuration for ${variables.join(", ")}: ${details.join("; ")}`);
    this.name = "ConfigError";
    this.variables = variables;
  }
}

/** Best-effort one-line message that is safe to log. */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").slice(0, 300);
}

/** An error whose message is already safe to show publicly (no hostnames, addresses, or driver text). */
export class PublicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicError";
  }
}

const SERVICE_LABEL = { kafka: "Kafka", mongodb: "MongoDB" } as const;

/**
 * Maps a raw client error to a generic category. Raw driver text can contain hostnames and
 * addresses, so only these descriptions may reach public endpoints (/api/status, /api/replays);
 * the full error goes to the server log.
 */
export function describeInfraError(raw: string, service?: keyof typeof SERVICE_LABEL): string {
  const name = service ? SERVICE_LABEL[service] : "Kafka or MongoDB";
  const brokers = service === "kafka" ? "the Kafka brokers" : service === "mongodb" ? "MongoDB" : "Kafka or MongoDB";
  if (/certificate|SSL|TLS|handshake|self.signed|unable to verify/i.test(raw)) {
    return `The TLS handshake with ${brokers} failed.`;
  }
  if (/unknown topic|UNKNOWN_TOPIC|does not host this topic/i.test(raw)) {
    return "The Kafka topic does not exist or is not accessible.";
  }
  if (/authentication failed|SASL|not authorized|authorization|unauthorized/i.test(raw)) {
    return `${name} rejected the credentials or the user lacks permission.`;
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|EPIPE|getaddrinfo|timed out|timeout|connection (error|closed)|server selection|no broker|broker|monitor/i.test(raw)) {
    return `Could not reach ${brokers}.`;
  }
  return `${name} reported an error; see the worker logs.`;
}

/** The message to expose for any thrown value: our own PublicError text, or a generic category. */
export function publicErrorMessage(error: unknown, service?: keyof typeof SERVICE_LABEL): string {
  if (error instanceof PublicError) return error.message;
  return describeInfraError(errorMessage(error), service);
}
