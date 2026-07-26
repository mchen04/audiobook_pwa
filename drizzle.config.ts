import { defineConfig } from "drizzle-kit";
import { loadEnvConfig } from "@next/env";

import { loadEnvFile } from "./scripts/lib/env-file.mjs";

// Test tooling names its env file explicitly (HARK_ENV_FILE=.env.test) so
// migrations can be pointed at the local container. Without it this falls back
// to Next's loader, which is what deploys and manual runs use.
if (process.env.HARK_ENV_FILE) loadEnvFile(process.env.HARK_ENV_FILE);
loadEnvConfig(process.cwd());

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for database tooling");
}

export default defineConfig({
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  strict: true,
  verbose: true,
});
