import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { assertLocalDatabase, describeDatabaseHost } from "./lib/assert-local-database.mjs";
import { loadEnvFile, resolveEnvFile } from "./lib/env-file.mjs";

// This server is what the e2e suites drive, so it defaults to .env.test rather
// than silently inheriting the developer's .env.local production credentials.
// Point it elsewhere with HARK_ENV_FILE=<path> or --env-file=<path>.
const root = process.cwd();
const output = path.join(root, ".next/standalone");
const envFile = resolveEnvFile();

loadEnvFile(envFile);

// Set by playwright.config.ts (and anything else that must never reach a hosted
// database). Verified here too, because this process is what actually connects.
if (process.env.HARK_REQUIRE_LOCAL_DB === "1") {
  assertLocalDatabase(process.env.DATABASE_URL, { context: "The standalone test server" });
}
console.log(
  `[run-standalone] env file: ${path.relative(root, envFile)} · DATABASE_URL host: ${
    process.env.DATABASE_URL ? describeDatabaseHost(process.env.DATABASE_URL) : "(unset)"
  }`,
);

mkdirSync(path.join(output, ".next"), { recursive: true });
for (const [source, destination] of [
  [path.join(root, ".next/static"), path.join(output, ".next/static")],
  [path.join(root, "public"), path.join(output, "public")],
]) {
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
}

await import(path.join(output, "server.js"));
