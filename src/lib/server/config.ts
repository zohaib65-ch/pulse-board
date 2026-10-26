import { z } from "zod";
import { ConfigError } from "./errors";
import { containsPemBlock, normalizePem } from "./pem";

/**
 * Runtime configuration, validated lazily with Zod.
 *
 * Nothing here runs at import time, so `next build` never needs live credentials.
 * Each getter validates only the variables it needs: read endpoints need MongoDB,
 * ingestion also needs Kafka and ADMIN_TOKEN, the worker validates MongoDB + Kafka at startup.
 */

const MONGO_DB_NAME = /^mongodb(?:\+srv)?:\/\/[^/?#]+\/([^/?#]+)/;

/** Database name from the connection string path (`mongodb+srv://host/<db>?...`). */
export function databaseNameFromUri(uri: string): string | null {
  const match = MONGO_DB_NAME.exec(uri.trim());
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]) || null;
  } catch {
    return null;
  }
}

const mongoUriSchema = z
  .string({ error: "is required" })
  .trim()
  .superRefine((value, ctx) => {
    if (!/^mongodb(\+srv)?:\/\//.test(value)) {
      ctx.addIssue({ code: "custom", message: "must start with mongodb:// or mongodb+srv://" });
    } else if (!databaseNameFromUri(value)) {
      ctx.addIssue({ code: "custom", message: "must include the database name after the host" });
    }
  });

const brokerSchema = z.string().regex(/^[A-Za-z0-9.-]+:\d{1,5}$/, "each broker must be host:port");

const brokersSchema = z
  .string({ error: "is required" })
  .transform((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  )
  .pipe(z.array(brokerSchema).min(1, "at least one broker is required"));

function pemSchema(labels: RegExp, description: string) {
  return z
    .string({ error: "is required" })
    .transform(normalizePem)
    .refine((value) => containsPemBlock(value, labels), `must contain a PEM ${description}`);
}

const PRIVATE_KEY = /PRIVATE KEY$/;
const CERTIFICATE = /^CERTIFICATE$/;

const mongoEnvSchema = z.object({ MONGODB_URI: mongoUriSchema });
const kafkaEnvSchema = z.object({
  KAFKA_BROKERS: brokersSchema,
  KAFKA_CA_CERT: pemSchema(CERTIFICATE, "certificate"),
  KAFKA_CLIENT_CERT: pemSchema(CERTIFICATE, "certificate"),
  KAFKA_CLIENT_KEY: pemSchema(PRIVATE_KEY, "private key"),
});
const adminEnvSchema = z.object({
  ADMIN_TOKEN: z.string({ error: "is required" }).min(24, "must be at least 24 characters"),
});

export interface MongoConfig {
  uri: string;
  dbName: string;
}

export interface KafkaConfig {
  brokers: string[];
  ca: string;
  cert: string;
  key: string;
}

type Env = Record<string, string | undefined>;

function parseEnv<S extends z.ZodType>(schema: S, env: Env, names: string[]): z.output<S> {
  const input = Object.fromEntries(names.map((name) => [name, env[name]]));
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const variables = [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "environment")))];
  const details = result.error.issues.map((issue) => `${String(issue.path[0] ?? "environment")} ${issue.message}`);
  throw new ConfigError(variables, details);
}

export function getMongoConfig(env: Env = process.env): MongoConfig {
  const { MONGODB_URI } = parseEnv(mongoEnvSchema, env, ["MONGODB_URI"]);
  const dbName = databaseNameFromUri(MONGODB_URI);
  if (!dbName) throw new ConfigError(["MONGODB_URI"], ["MONGODB_URI must include the database name"]);
  return { uri: MONGODB_URI, dbName };
}

export function getKafkaConfig(env: Env = process.env): KafkaConfig {
  const parsed = parseEnv(kafkaEnvSchema, env, [
    "KAFKA_BROKERS",
    "KAFKA_CA_CERT",
    "KAFKA_CLIENT_CERT",
    "KAFKA_CLIENT_KEY",
  ]);
  return {
    brokers: parsed.KAFKA_BROKERS,
    ca: parsed.KAFKA_CA_CERT,
    cert: parsed.KAFKA_CLIENT_CERT,
    key: parsed.KAFKA_CLIENT_KEY,
  };
}

export function getAdminToken(env: Env = process.env): string {
  return parseEnv(adminEnvSchema, env, ["ADMIN_TOKEN"]).ADMIN_TOKEN;
}

/** Validated once at worker startup; throws ConfigError naming every bad variable. */
export function validateWorkerConfig(env: Env = process.env): { mongo: MongoConfig; kafka: KafkaConfig } {
  const problems: ConfigError[] = [];
  let mongo: MongoConfig | undefined;
  let kafka: KafkaConfig | undefined;
  try {
    mongo = getMongoConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) problems.push(error);
    else throw error;
  }
  try {
    kafka = getKafkaConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) problems.push(error);
    else throw error;
  }
  if (problems.length > 0 || !mongo || !kafka) {
    throw new ConfigError(
      problems.flatMap((problem) => problem.variables),
      problems.map((problem) => problem.message.replace(/^Invalid configuration for [^:]+: /, "")),
    );
  }
  return { mongo, kafka };
}
