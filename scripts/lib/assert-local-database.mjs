// Refuses to let a destructive or end-to-end suite touch a hosted database.
//
// The e2e suite registers accounts, imports books, and the bootstrap script
// drops and recreates the schema. Pointed at Neon that is production damage, so
// this guard fails loudly instead of doing the work. It is wired into
// playwright.config.ts, scripts/run-standalone.mjs, and scripts/test-db.mjs.
//
// Run it directly to check an environment:
//   node scripts/test-db.mjs guard
//   DATABASE_URL=... node scripts/lib/assert-local-database.mjs

// Hosts that are unambiguously a managed/hosted Postgres. Matched as a suffix of
// the hostname so `evil-neon.tech.example.com` is not treated as Neon, while
// `ep-x-pooler.us-east-1.aws.neon.tech` is.
const HOSTED_DATABASE_SUFFIXES = [
  "neon.tech",
  "neon.build",
  "supabase.co",
  "supabase.com",
  "rds.amazonaws.com",
  "render.com",
  "railway.app",
  "planetscale.com",
  "cockroachlabs.cloud",
  "vercel-storage.com",
  "digitalocean.com",
];

const banner = "\n" + "=".repeat(72) + "\n";

const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "host.docker.internal",
  // Compose service name, for when a runner lives on the compose network.
  "postgres",
]);

/**
 * @param {string} url
 * @returns {URL}
 */
function parseDatabaseUrl(url) {
  try {
    return new URL(url);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL, so its host cannot be verified.");
  }
}

/**
 * The host and port only. Never returns user, password, or query string, so it
 * is safe to print in CI logs and agent reports.
 *
 * @param {string} url
 * @returns {string}
 */
export function describeDatabaseHost(url) {
  const parsed = parseDatabaseUrl(url);
  return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
}

/**
 * @param {string} hostname
 * @returns {string | null} the matched hosted-provider suffix, if any
 */
function hostedProviderFor(hostname) {
  const lower = hostname.toLowerCase();
  return (
    HOSTED_DATABASE_SUFFIXES.find((suffix) => lower === suffix || lower.endsWith(`.${suffix}`)) ??
    null
  );
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function isLocalHostname(hostname) {
  const lower = hostname.toLowerCase().replaceAll(/^\[|\]$/g, "");
  return LOCAL_HOSTNAMES.has(lower) || lower.endsWith(".localhost");
}

/**
 * Throws unless DATABASE_URL points at a database on this machine.
 *
 * @param {string | undefined} url
 * @param {{ context?: string }} [options]
 * @returns {string} the verified host, safe to print
 */
export function assertLocalDatabase(url, options = {}) {
  const context = options.context ?? "This suite";

  if (!url) {
    throw new Error(
      `${banner}\n${context} requires DATABASE_URL to be set to the LOCAL test database.\n` +
        `It is unset. Start the local database and load .env.test:\n` +
        `  node scripts/test-db.mjs\n${banner}`,
    );
  }

  const parsed = parseDatabaseUrl(url);
  const host = describeDatabaseHost(url);
  const hostedProvider = hostedProviderFor(parsed.hostname);

  if (hostedProvider) {
    throw new Error(
      `${banner}\nREFUSING TO RUN: ${context} is pointed at the HOSTED database "${hostedProvider}".\n` +
        `  DATABASE_URL host: ${host}\n` +
        `This suite creates accounts, writes books, and resets the schema. Running it\n` +
        `against a hosted database would damage real data.\n\n` +
        `Fix: start the local test database and use .env.test instead.\n` +
        `  node scripts/test-db.mjs\n` +
        `  HARK_ENV_FILE=.env.test <your command>\n${banner}`,
    );
  }

  if (!isLocalHostname(parsed.hostname)) {
    throw new Error(
      `${banner}\nREFUSING TO RUN: ${context} is pointed at a REMOTE database host.\n` +
        `  DATABASE_URL host: ${host}\n` +
        `Only a database on this machine may be used. Expected one of:\n` +
        `  ${[...LOCAL_HOSTNAMES].join(", ")}\n\n` +
        `Fix: node scripts/test-db.mjs   (then use .env.test)\n${banner}`,
    );
  }

  return host;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const host = assertLocalDatabase(process.env.DATABASE_URL, {
      context: process.env.HARK_GUARD_CONTEXT ?? "This command",
    });
    console.log(`local-database guard OK — DATABASE_URL host: ${host}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
