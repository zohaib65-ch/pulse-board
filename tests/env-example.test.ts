import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { getAdminToken, getKafkaConfig, getMongoConfig } from "@/lib/server/config";

const example = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));

describe(".env.example", () => {
  it("lists exactly the six application variables", () => {
    expect(Object.keys(example).sort()).toEqual(
      ["ADMIN_TOKEN", "KAFKA_BROKERS", "KAFKA_CA_CERT", "KAFKA_CLIENT_CERT", "KAFKA_CLIENT_KEY", "MONGODB_URI"],
    );
  });

  it("uses placeholders that satisfy the format checks but are obviously not credentials", () => {
    // Shape is valid (so a copied file fails at connection time with a clear error, not at parsing)...
    expect(getMongoConfig(example).dbName).toBe("pulseboard");
    expect(getKafkaConfig(example).brokers).toHaveLength(1);
    expect(getAdminToken(example).length).toBeGreaterThanOrEqual(24);
    // ...and every secret is an explicit placeholder.
    for (const key of ["MONGODB_URI", "KAFKA_CA_CERT", "KAFKA_CLIENT_CERT", "KAFKA_CLIENT_KEY", "ADMIN_TOKEN"]) {
      expect(example[key], key).toMatch(/REPLACE_ME/);
    }
  });
});
