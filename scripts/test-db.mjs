// Bootstraps the LOCAL Postgres that every Hark test suite runs against.
//
// Why local: Neon's cold start makes each suite slow and flaky, tests have to
// work offline, and parallel runs against one shared remote database interfere.
//
// Usage:
//   node scripts/test-db.mjs            # start the container, migrate, seed
//   node scripts/test-db.mjs up         # same as above
//   node scripts/test-db.mjs reset      # destroy the volume, then bootstrap
//   node scripts/test-db.mjs down       # stop the container, keep the volume
//   node scripts/test-db.mjs migrate    # re-run migrations only
//   node scripts/test-db.mjs seed       # re-seed the e2e account only
//   node scripts/test-db.mjs guard      # prove the neon.tech guard is wired up
//   node scripts/test-db.mjs psql -- -c 'select 1'   # psql inside the container
//
// Every subcommand reads .env.test (override with HARK_ENV_FILE or
// --env-file=<path>) and refuses to touch anything but a local database.

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";

import { assertLocalDatabase, describeDatabaseHost } from "./lib/assert-local-database.mjs";
import { loadEnvFile, resolveEnvFile } from "./lib/env-file.mjs";

const COMPOSE_SERVICE = "postgres";
const READY_TIMEOUT_MS = 90_000;

const argv = process.argv.slice(2);
const passThrough = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : [];
const positional = (argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv).filter(
  (argument) => !argument.startsWith("-"),
);
const command = positional[0] ?? "up";

const envFile = resolveEnvFile({ argv });
loadEnvFile(envFile);
ensureGeneratedSecrets(envFile);

const databaseUrl = process.env.DATABASE_URL;
const host = assertLocalDatabase(databaseUrl, { context: "The test-database bootstrap" });

/**
 * Fills in the values `.env.test.example` deliberately ships empty.
 *
 * The session signing key and the test account's password used to be literals
 * in the committed example file, and a secret scanner flagged them — correctly.
 * They are not real secrets, which is exactly the problem: a committed string
 * that looks like a credential teaches everyone to wave the scanner through, and
 * then the one that matters looks the same.
 *
 * Only ever fills a BLANK value, and never rewrites one that is already set, so
 * running this against an existing `.env.test` cannot invalidate the sessions or
 * the seeded account a working setup already has.
 *
 * @param {string} file
 */
function ensureGeneratedSecrets(file) {
  const generators = {
    BETTER_AUTH_SECRET: () => randomBytes(32).toString("hex"),
    // Upper, lower, digits and a symbol, comfortably past the 12-character
    // minimum the register route enforces.
    HARK_TEST_ACCOUNT_PASSWORD: () => `Hk-${randomBytes(12).toString("base64url")}-1!`,
  };

  const missing = Object.keys(generators).filter((key) => !process.env[key]);
  if (!missing.length) return;

  let contents = "";
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    console.error(
      `▸ ${path.relative(process.cwd(), file)} does not exist yet.\n` +
        "  Copy it from .env.test.example first: cp .env.test.example .env.test",
    );
    process.exit(1);
  }

  for (const key of missing) {
    const value = generators[key]();
    process.env[key] = value;
    const assignment = `${key}=${value}`;
    contents = new RegExp(`^${key}=.*$`, "m").test(contents)
      ? contents.replace(new RegExp(`^${key}=.*$`, "m"), assignment)
      : `${contents.replace(/\n*$/, "\n")}${assignment}\n`;
  }
  writeFileSync(file, contents, "utf8");
  console.log(`▸ Generated ${missing.join(", ")} into ${path.relative(process.cwd(), file)}`);
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, capture?: boolean }} [options]
 * @returns {Promise<string>}
 */
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
      env: options.env ?? process.env,
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${file} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

/** @param {string[]} args */
const compose = (args, options) => run("docker", ["compose", ...args], options);

/** @param {string} message */
const step = (message) => console.log(`\n▸ ${message}`);

async function waitForReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5, idle_timeout: 1 });
    try {
      await sql`select 1`;
      await sql.end({ timeout: 1 });
      return;
    } catch (error) {
      lastError = error;
      await sql.end({ timeout: 1 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(
    `Local Postgres at ${host} did not become ready within ${READY_TIMEOUT_MS / 1000}s: ${lastError}`,
  );
}

async function ensureExtensions() {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    // Migration 0009 also does this, but the extension is a hard prerequisite of
    // the gin_trgm_ops indexes, so create it up front and verify it landed.
    await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
    const [trgm] = await sql`select extversion from pg_extension where extname = 'pg_trgm'`;
    if (!trgm) throw new Error("pg_trgm is not available in this Postgres image");
    const [version] = await sql`show server_version`;
    console.log(`  postgres ${version.server_version} · pg_trgm ${trgm.extversion}`);
  } finally {
    await sql.end();
  }
}

async function migrate() {
  await run("pnpm", ["exec", "drizzle-kit", "migrate"], {
    env: { ...process.env, HARK_ENV_FILE: envFile },
  });
}

async function reportTables() {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const applied = await sql`select count(*)::int as count from drizzle.__drizzle_migrations`;
    const tables = await sql`
      select tablename from pg_tables where schemaname = 'public' order by tablename
    `;
    console.log(`  ${applied[0].count} migrations applied · ${tables.length} public tables`);
  } finally {
    await sql.end();
  }
}

async function seed() {
  const email = process.env.HARK_TEST_ACCOUNT_EMAIL;
  const password = process.env.HARK_TEST_ACCOUNT_PASSWORD;
  const name = process.env.HARK_TEST_ACCOUNT_NAME ?? "Hark Test Account";
  if (!email || !password) {
    throw new Error(
      "HARK_TEST_ACCOUNT_EMAIL and HARK_TEST_ACCOUNT_PASSWORD must be set in .env.test",
    );
  }

  // Better Auth owns the credential hash format, so ask it rather than
  // reimplementing scrypt. A hand-rolled hash would sign in nowhere.
  const { hashPassword } = await import("better-auth/crypto");
  const hashed = await hashPassword(password);

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    // Deterministic id keeps re-seeding idempotent and makes the seeded rows
    // obvious in any dump.
    const userId = `seed-${createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 24)}`;
    await sql`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES (${userId}, ${name}, ${email}, true)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, email = excluded.email
    `;
    const [existing] = await sql`
      SELECT id FROM account WHERE provider_id = 'credential' AND user_id = ${userId}
    `;
    if (existing) {
      await sql`UPDATE account SET password = ${hashed}, updated_at = now() WHERE id = ${existing.id}`;
    } else {
      await sql`
        INSERT INTO account (id, account_id, provider_id, user_id, password)
        VALUES (${randomUUID()}, ${userId}, 'credential', ${userId}, ${hashed})
      `;
    }
    console.log(`  seeded credential account ${email}`);
  } finally {
    await sql.end();
  }
}

async function up() {
  step(`Starting local Postgres (host ${host})`);
  await compose(["up", "-d", COMPOSE_SERVICE]);

  step("Waiting for readiness");
  await waitForReady();

  step("Ensuring extensions");
  await ensureExtensions();

  step("Running migrations");
  await migrate();
  await reportTables();

  step("Seeding the e2e account");
  await seed();

  console.log(`\n✔ Local test database ready at ${host} (env file: ${envFile})`);
}

switch (command) {
  case "up":
    await up();
    break;
  case "reset":
    step("Destroying the local test database volume");
    await compose(["down", "-v"]);
    await up();
    break;
  case "down":
    step("Stopping the local test database");
    await compose(["down"]);
    break;
  case "migrate":
    await waitForReady();
    await ensureExtensions();
    await migrate();
    await reportTables();
    break;
  case "seed":
    await waitForReady();
    await seed();
    break;
  case "guard":
    console.log(
      `local-database guard OK — DATABASE_URL host: ${describeDatabaseHost(databaseUrl)}`,
    );
    break;
  case "psql":
    await compose([
      "exec",
      "-T",
      COMPOSE_SERVICE,
      "psql",
      "-U",
      new URL(databaseUrl).username,
      "-d",
      new URL(databaseUrl).pathname.slice(1),
      ...passThrough,
    ]);
    break;
  default:
    console.error(`Unknown command "${command}". See the usage block in ${import.meta.url}.`);
    process.exit(1);
}
