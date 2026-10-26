import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Browser-facing code must never reach Kafka, MongoDB, Node built-ins, or server-only modules.
const browserBoundary = {
  patterns: [
    {
      group: ["@/lib/server", "@/lib/server/*", "**/lib/server/**", "@/../workers/*", "**/workers/**"],
      message: "Browser code must not import server modules (Kafka, MongoDB, configuration, secrets).",
    },
    { group: ["kafkajs", "mongodb", "node:*"], message: "Kafka, MongoDB, and Node built-ins are server-only." },
  ],
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: [
      "src/components/**/*.{ts,tsx}",
      "src/hooks/**/*.{ts,tsx}",
      "src/lib/client/**/*.{ts,tsx}",
      "src/lib/format.ts",
      "src/lib/utils.ts",
      "src/shared/**/*.ts",
      "src/app/**/*.tsx",
    ],
    rules: { "no-restricted-imports": ["error", browserBoundary] },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "coverage/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
