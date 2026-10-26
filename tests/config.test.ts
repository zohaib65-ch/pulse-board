import { describe, expect, it } from "vitest";
import {
  databaseNameFromUri,
  getAdminToken,
  getKafkaConfig,
  getMongoConfig,
  validateWorkerConfig,
} from "@/lib/server/config";
import { ConfigError } from "@/lib/server/errors";
import { containsPemBlock, normalizePem } from "@/lib/server/pem";

const BODY = "MIIBszCCAVmgAwIBAgIUQ0hlbGxvQ2xhdWRlVGVzdENlcnRpZmljYXRlMDAwMDAw".repeat(2);
const CERT = `-----BEGIN CERTIFICATE-----\n${BODY.slice(0, 64)}\n${BODY.slice(64)}\n-----END CERTIFICATE-----\n`;
const KEY = `-----BEGIN PRIVATE KEY-----\n${BODY.slice(0, 64)}\n-----END PRIVATE KEY-----\n`;

const goodEnv = {
  MONGODB_URI: "mongodb+srv://user:pw@cluster0.example.mongodb.net/pulseboard?retryWrites=true",
  KAFKA_BROKERS: "kafka-a.example.com:12345, kafka-b.example.com:12345",
  KAFKA_CA_CERT: CERT,
  KAFKA_CLIENT_CERT: CERT,
  KAFKA_CLIENT_KEY: KEY,
  ADMIN_TOKEN: "x".repeat(32),
};

describe("PEM normalization", () => {
  it("keeps real newlines", () => {
    expect(normalizePem(CERT)).toBe(CERT);
  });

  it("converts escaped \\n sequences", () => {
    expect(normalizePem(CERT.replace(/\n/g, "\\n"))).toBe(CERT);
  });

  it("repairs newlines flattened to spaces and strips wrapping quotes", () => {
    const flattened = `"${CERT.trim().replace(/\n/g, " ")}"`;
    expect(normalizePem(flattened)).toBe(CERT);
  });

  it("handles CRLF and certificate bundles", () => {
    const bundle = normalizePem(`${CERT}${CERT}`.replace(/\n/g, "\r\n"));
    expect(bundle.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(bundle).not.toContain("\r");
  });

  it("recognizes private keys of any flavour but not certificates as keys", () => {
    expect(containsPemBlock(KEY, /PRIVATE KEY$/)).toBe(true);
    expect(containsPemBlock(CERT, /PRIVATE KEY$/)).toBe(false);
  });
});

describe("configuration validation", () => {
  it("reads the database name from the MongoDB URI", () => {
    expect(databaseNameFromUri("mongodb+srv://u:p@h.net/pulseboard?x=1")).toBe("pulseboard");
    expect(databaseNameFromUri("mongodb://a:1,b:2/appdb")).toBe("appdb");
    expect(databaseNameFromUri("mongodb+srv://u:p@h.net/?x=1")).toBeNull();
    expect(databaseNameFromUri("mongodb+srv://u:p@h.net")).toBeNull();
  });

  it("accepts a complete configuration with escaped PEM newlines", () => {
    const escaped = { ...goodEnv, KAFKA_CA_CERT: CERT.replace(/\n/g, "\\n") };
    expect(getMongoConfig(escaped).dbName).toBe("pulseboard");
    const kafka = getKafkaConfig(escaped);
    expect(kafka.brokers).toEqual(["kafka-a.example.com:12345", "kafka-b.example.com:12345"]);
    expect(kafka).toMatchObject({ tls: true, ca: CERT });
    expect(getAdminToken(goodEnv)).toHaveLength(32);
    expect(() => validateWorkerConfig(goodEnv)).not.toThrow();
  });

  it("does not throw until a value is actually needed (build without credentials)", async () => {
    // Importing the config and server modules must never read the environment.
    await expect(import("@/lib/server/config")).resolves.toBeDefined();
  });

  it("names the bad variables but never echoes their values", () => {
    const secret = "super-secret-credential-value";
    try {
      validateWorkerConfig({ ...goodEnv, MONGODB_URI: `http://${secret}`, KAFKA_BROKERS: "", KAFKA_CLIENT_KEY: secret });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const config = error as ConfigError;
      expect(config.variables).toEqual(expect.arrayContaining(["MONGODB_URI", "KAFKA_BROKERS", "KAFKA_CLIENT_KEY"]));
      expect(config.message).not.toContain(secret);
    }
  });

  it("rejects a MongoDB URI without a database name and short admin tokens", () => {
    expect(() => getMongoConfig({ ...goodEnv, MONGODB_URI: "mongodb+srv://u:p@h.net/?x=1" })).toThrow(ConfigError);
    expect(() => getAdminToken({ ADMIN_TOKEN: "short" })).toThrow(ConfigError);
    expect(() => getAdminToken({})).toThrow(ConfigError);
  });

  it("requires every Kafka credential", () => {
    for (const name of ["KAFKA_BROKERS", "KAFKA_CA_CERT", "KAFKA_CLIENT_CERT", "KAFKA_CLIENT_KEY"] as const) {
      expect(() => getKafkaConfig({ ...goodEnv, [name]: undefined })).toThrow(ConfigError);
    }
    expect(() => getKafkaConfig({ ...goodEnv, KAFKA_CLIENT_KEY: CERT })).toThrow(ConfigError);
  });

  it("keeps TLS on by default and for any KAFKA_SSL value other than exactly \"false\"", () => {
    for (const KAFKA_SSL of [undefined, "", "true", "0", "no", "off"]) {
      expect(getKafkaConfig({ ...goodEnv, KAFKA_SSL }).tls).toBe(true);
      expect(() => getKafkaConfig({ ...goodEnv, KAFKA_SSL, KAFKA_CA_CERT: undefined })).toThrow(ConfigError);
    }
  });

  it("allows plaintext Kafka only for brokers on this machine", () => {
    const local = getKafkaConfig({ KAFKA_BROKERS: "localhost:9094, 127.0.0.1:9095", KAFKA_SSL: "false" });
    expect(local).toEqual({ tls: false, brokers: ["localhost:9094", "127.0.0.1:9095"] });
    expect(() => getKafkaConfig({ ...goodEnv, KAFKA_SSL: "false" })).toThrow(/localhost or 127\.0\.0\.1/);
    expect(() => getKafkaConfig({ KAFKA_BROKERS: "localhost:9094,kafka.example.com:12345", KAFKA_SSL: "false" })).toThrow(ConfigError);
    expect(() => getKafkaConfig({ KAFKA_BROKERS: "notlocalhost:9094", KAFKA_SSL: "false" })).toThrow(ConfigError);
  });
});
