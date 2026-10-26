// Bundles the worker (and the shared code it imports) into one self-contained file.
// The container then needs no node_modules, and no secrets are involved at build time.
import { build } from "esbuild";

await build({
  entryPoints: ["workers/index.ts"],
  outfile: "dist/worker.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  // Resolves the "@/..." alias from tsconfig.json so the worker shares code with the web app.
  tsconfig: "tsconfig.json",
  sourcemap: "linked",
  legalComments: "none",
  // Optional native/cloud add-ons of the MongoDB driver. The driver loads them lazily and
  // works without them, so they are left out of the bundle.
  external: [
    "@aws-sdk/credential-providers",
    "@mongodb-js/zstd",
    "gcp-metadata",
    "kerberos",
    "mongodb-client-encryption",
    "snappy",
    "socks",
  ],
  logLevel: "info",
});
