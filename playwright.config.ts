import { defineConfig, devices } from "@playwright/test";

import { assertLocalDatabase } from "./scripts/lib/assert-local-database.mjs";
import { DEFAULT_TEST_ENV_FILE, loadEnvFile } from "./scripts/lib/env-file.mjs";
import { materializeRandomSyncSeeds } from "./tests/sync/harness/seeds";

// The e2e suite registers accounts and imports books, so it reads .env.test and
// never .env.local. Start the database it expects with: node scripts/test-db.mjs
const envFile = process.env.HARK_ENV_FILE ?? DEFAULT_TEST_ENV_FILE;
loadEnvFile(envFile);
materializeRandomSyncSeeds();

// Refuses to continue if this is aimed at a hosted database. Also re-checked
// inside scripts/run-standalone.mjs, which is the process that connects.
const databaseHost = assertLocalDatabase(process.env.DATABASE_URL, {
  context: "The Playwright e2e suite",
});
console.log(`[playwright] env file: ${envFile} · DATABASE_URL host: ${databaseHost}`);

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";

const serverEnv: Record<string, string> = {
  HARK_ENV_FILE: envFile,
  HARK_REQUIRE_LOCAL_DB: "1",
  DATABASE_URL: process.env.DATABASE_URL as string,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET as string,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? baseURL,
};
if (process.env.ALLOW_LOCAL_MAIL_CAPTURE) {
  serverEnv.ALLOW_LOCAL_MAIL_CAPTURE = process.env.ALLOW_LOCAL_MAIL_CAPTURE;
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: "line",
  use: {
    baseURL,
    serviceWorkers: "allow",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "iphone-webkit",
      use: {
        ...devices["iPhone 15"],
        browserName: "webkit",
      },
    },
    // The suites below drive their own launchPersistentContext, because a fresh
    // context would discard the service worker, Cache Storage and IndexedDB that
    // make a warm launch fast — which is exactly what they exist to measure.
    {
      name: "launch-perf",
      testDir: "./tests/perf",
      // Four profiles x repeated launches, one of them delayed by 3000ms.
      timeout: 600_000,
      use: { ...devices["iPhone 15"], browserName: "webkit" },
    },
    {
      name: "parity",
      testDir: "./tests/parity",
      // Vitest owns the *.test.ts files here (executable server/mirror parity).
      testIgnore: "**/*.test.ts",
      timeout: 240_000,
      use: { ...devices["iPhone 15"], browserName: "webkit" },
    },
    {
      // The resume oracle. Drives its own persistent contexts and kills them
      // with SIGKILL, so it cannot share a context with anything else.
      // `HARK_RESUME_TESTDIR` points it at a spec file kept outside the repo,
      // which is how the held-out scenarios stay held out.
      name: "resume-durability",
      testDir: process.env.HARK_RESUME_TESTDIR ?? "./tests/resume",
      timeout: 900_000,
      use: { ...devices["iPhone 15"], browserName: "webkit" },
    },
    {
      name: "sync",
      testDir: "./tests/sync",
      testIgnore: "**/*.test.ts",
      // Fuzz seeds interleaved with offline/online transitions and reloads.
      timeout: 900_000,
      use: { ...devices["iPhone 15"], browserName: "webkit" },
    },
  ],
  webServer: {
    command: "pnpm build && node scripts/run-standalone.mjs",
    url: baseURL,
    // A server already listening on this port may be a dev server wired to a
    // hosted database, and reusing it would silently test against production.
    // Opt back in with HARK_REUSE_SERVER=1 once you know what is running.
    reuseExistingServer: process.env.HARK_REUSE_SERVER === "1",
    timeout: 180_000,
    env: serverEnv,
    // So every run records which database the app process actually connected to.
    stdout: "pipe",
  },
});
