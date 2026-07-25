import {
  chromium,
  devices,
  expect,
  test,
  webkit,
  type BrowserContext,
  type BrowserType,
  type Page,
  type Route,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";

import { assertLocalDatabase } from "../../scripts/lib/assert-local-database.mjs";
import { DEFAULT_TEST_ENV_FILE, loadEnvFile } from "../../scripts/lib/env-file.mjs";

import {
  PROBE_PATH,
  startLatencyProxy,
  type LatencyProxy,
  type ProxyReport,
} from "./latency-proxy";

/**
 * The launch benchmark.
 *
 * It answers one question: how long after the icon tap is the user's REAL
 * library on screen, on every network the user can be on — and it is built so
 * that it cannot answer that question dishonestly.
 *
 * Four things guard the number:
 *   1. The library is seeded to a realistic size and the size is asserted, so a
 *      two-book library can never make the bar trivial.
 *   2. Every launch runs in ONE persistent context, and the service worker's
 *      survival is re-proved before each profile. If persistence broke, every
 *      launch would silently be a cold launch.
 *   3. Server hit counts, not timings, decide whether the document came from
 *      cache. A fast server and a cached document look identical on a clock.
 *   4. Each delayed profile proves its delay actually bit, and the offline
 *      profile proves the network really is gone, before its launches count.
 *
 * The 500ms and 150ms bars are frozen. Nothing in this file may relax them.
 */

// ---------------------------------------------------------------- frozen bars
const P95_BAR_MS = 500;
const SPREAD_BAR_MS = 150;

// ------------------------------------------------------------------- settings
const LAUNCHES_PER_PROFILE = 6;
const LAUNCH_TIMEOUT_MS = 15_000;
/** The full `scripts/seed-perf.mjs` library: the size a real owner has. */
const MIN_BOOKS = 1000;
const START_URL_PATH = "/library?source=pwa";

type Profile = {
  id: string;
  label: string;
  delayMs: number;
  offline: boolean;
};

const PROFILES: Profile[] = [
  { id: "A", label: "fast (0ms)", delayMs: 0, offline: false },
  { id: "B", label: "slow (400ms)", delayMs: 400, offline: false },
  { id: "C", label: "cold database (3000ms)", delayMs: 3000, offline: false },
  { id: "D", label: "offline", delayMs: 0, offline: true },
];

type Launch = {
  ms: number;
  timedOut: boolean;
  readyKind: string | null;
  inPageMs: number | null;
  hits: ProxyReport;
  queries: number;
};

type ProfileResult = {
  profile: Profile;
  launches: Launch[];
  armedEvidence: string;
  persistenceEvidence: string;
};

const envFile = process.env.HARK_ENV_FILE ?? DEFAULT_TEST_ENV_FILE;
loadEnvFile(envFile);
const databaseHost = assertLocalDatabase(process.env.DATABASE_URL, {
  context: "The launch benchmark",
});
const appOrigin = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";
const account = {
  email: process.env.HARK_TEST_ACCOUNT_EMAIL ?? "",
  password: process.env.HARK_TEST_ACCOUNT_PASSWORD ?? "",
};

let bookCount = 0;
let engineNote = "";

// ------------------------------------------------------------ engine choice
/**
 * The benchmark is about a document served cache-first out of Cache Storage,
 * across launches, in a persistent profile. An engine that cannot read back
 * what it wrote to Cache Storage cannot host that measurement at all: the
 * harness would stay red no matter how correct the app became, which is just a
 * different way of measuring nothing.
 *
 * So the engine is chosen by capability, not by preference, and the choice is
 * printed. WebKit is tried first because iOS Safari is the target; Chromium is
 * used only if WebKit's persistent context fails the probe, and that fallback
 * is stated loudly wherever the numbers appear.
 */
type Engine = { name: string; browserType: BrowserType; evidence: string[] };

async function selectEngine(): Promise<Engine> {
  const candidates: Array<[string, BrowserType]> = [
    ["webkit", webkit],
    ["chromium", chromium],
  ];
  const evidence: string[] = [];

  for (const [name, browserType] of candidates) {
    const dir = mkdtempSync(path.join(tmpdir(), `hark-engine-${name}-`));
    let readBack: string | null = null;
    let failure = "";
    try {
      const context = await browserType.launchPersistentContext(dir, {
        ...devices["iPhone 15"],
        serviceWorkers: "allow",
      });
      try {
        const page = await context.newPage();
        await page.goto(`${appOrigin}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        readBack = await page.evaluate(async () => {
          const cache = await caches.open("hark-engine-probe");
          await cache.put("/hark-engine-probe", new Response("probe-body"));
          const hit = await (await caches.open("hark-engine-probe")).match("/hark-engine-probe");
          const body = hit ? await hit.text() : null;
          await caches.delete("hark-engine-probe");
          return body;
        });
      } finally {
        await context.close();
      }
    } catch (error) {
      failure = String(error).split("\n")[0] ?? "";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const capable = readBack === "probe-body";
    evidence.push(
      `${name} persistent context: Cache Storage read-back = ${JSON.stringify(readBack)}` +
        (failure ? ` (${failure})` : "") +
        (capable ? " — USABLE" : " — UNUSABLE for a cache-first launch measurement"),
    );
    if (capable) return { name, browserType, evidence };
  }

  throw new Error(
    "No browser engine can read back from Cache Storage in a persistent context, so a " +
      "cache-first launch cannot be measured at all:\n  " +
      evidence.join("\n  "),
  );
}

// ----------------------------------------------------------------- statistics
/** Nearest-rank percentile. With n launches, p95 is the ceil(0.95n)-th slowest. */
function percentile(values: number[], fraction: number): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1] as number;
}

function round(value: number): number {
  return Math.round(value);
}

// -------------------------------------------------------------------- seeding
async function ensureRealisticLibrary(): Promise<number> {
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  try {
    const [user] = await sql`
      SELECT id FROM "user" WHERE lower(email) = ${account.email.toLowerCase()}
    `;
    if (!user) {
      throw new Error(
        `No account ${account.email} in the local database. Run: node scripts/test-db.mjs seed`,
      );
    }
    const countBooks = async () => {
      const [row] = await sql`
        SELECT count(*)::int AS total FROM books WHERE owner_id = ${user.id}
      `;
      return Number(row?.total ?? 0);
    };

    let total = await countBooks();
    if (total < MIN_BOOKS) {
      // Seeding is part of the harness, not a step someone has to remember. A
      // benchmark that can be pointed at an empty account eventually will be.
      console.log(
        `[launch-benchmark] library has ${total} books; seeding to at least ${MIN_BOOKS}…`,
      );
      execFileSync(
        process.execPath,
        [path.join(process.cwd(), "scripts/seed-perf.mjs"), account.email, `--env-file=${envFile}`],
        { stdio: "inherit" },
      );
      total = await countBooks();
    }
    return total;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ------------------------------------------------------- server-side counters
async function readQueryCount(reset: boolean): Promise<number> {
  const response = await fetch(`${appOrigin}/api/perf/query-count${reset ? "?reset=1" : ""}`, {
    cache: "no-store",
  });
  if (response.status === 404) {
    throw new Error(
      "The Postgres query counter is not enabled on the app server. It is gated on " +
        "HARK_REQUIRE_LOCAL_DB=1, which playwright.config.ts sets for the test server. " +
        "Without it the harness cannot prove zero queries on the paint path, so it refuses to run.",
    );
  }
  if (!response.ok) throw new Error(`Query counter returned HTTP ${response.status}.`);
  const payload = (await response.json()) as { count: number };
  return payload.count;
}

// -------------------------------------------------------------- one "launch"
/**
 * A launch is a brand new page in the SAME persistent context, navigating to
 * the manifest `start_url`. New page = fresh document, fresh JS heap, fresh
 * paint. Same context = the service worker, Cache Storage, IndexedDB and
 * cookies that a real second launch would still have.
 */
async function measureLaunch(
  context: BrowserContext,
  proxy: LatencyProxy,
  url: string,
): Promise<Launch> {
  proxy.reset();
  await readQueryCount(true);

  const page = await context.newPage();
  await page.addInitScript(() => {
    const target = window as unknown as { __harkLaunchReadyMs: number | null };
    target.__harkLaunchReadyMs = null;
    const found = () => {
      if (target.__harkLaunchReadyMs !== null) return true;
      if (!document.querySelector("[data-launch-ready]")) return false;
      target.__harkLaunchReadyMs = performance.now();
      return true;
    };
    if (!found()) {
      const observer = new MutationObserver(() => {
        if (found()) observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true, attributes: true });
    }
  });

  const started = performance.now();
  let timedOut = false;
  try {
    // "commit" rather than "load": the clock must stop at painted content, not
    // at the load event, and an offline navigation must not throw before the
    // service worker gets its chance to answer.
    await page.goto(url, { waitUntil: "commit", timeout: LAUNCH_TIMEOUT_MS });
  } catch {
    // Recorded through the readiness wait below, never swallowed.
  }
  let readyKind: string | null = null;
  try {
    const remaining = Math.max(250, LAUNCH_TIMEOUT_MS - (performance.now() - started));
    const marker = await page.waitForSelector("[data-launch-ready]", {
      state: "attached",
      timeout: remaining,
    });
    readyKind = await marker.getAttribute("data-launch-ready");
  } catch {
    timedOut = true;
  }
  const ms = performance.now() - started;

  let inPageMs: number | null = null;
  if (!timedOut) {
    inPageMs = await page
      .evaluate(
        () => (window as unknown as { __harkLaunchReadyMs: number | null }).__harkLaunchReadyMs,
      )
      .catch(() => null);
  }

  const queries = await readQueryCount(true);
  const hits = proxy.report();
  await page.close();

  return { ms, timedOut, readyKind, inPageMs, hits, queries };
}

// ------------------------------------------------------------- armed profiles
/**
 * Proves the profile is what it claims to be before its launches are counted.
 * A benchmark whose four profiles have quietly collapsed into four copies of
 * "fast" reports beautiful numbers and measures nothing.
 */
async function proveProfileArmed(
  context: BrowserContext,
  proxy: LatencyProxy,
  profile: Profile,
): Promise<string> {
  const probeUrl = `${proxy.origin}${PROBE_PATH}?nonce=${Date.now()}-${Math.random()}`;
  const page = await context.newPage();
  try {
    // The probe is a same-origin fetch the service worker explicitly does not
    // intercept (/api/ falls through to the network). On the offline profile
    // the navigation itself may fail; that is not what is being proved here.
    await page
      .goto(`${proxy.origin}/library`, { waitUntil: "commit", timeout: LAUNCH_TIMEOUT_MS })
      .catch(() => undefined);

    if (profile.offline) {
      const outcome = await page.evaluate(async (url) => {
        const started = performance.now();
        try {
          await fetch(url, { cache: "no-store" });
          return { reached: true, ms: performance.now() - started };
        } catch {
          return { reached: false, ms: performance.now() - started };
        }
      }, probeUrl);
      expect(
        outcome.reached,
        "Profile D claims the network is gone, but a control request reached the server. " +
          "The offline profile is not armed and its numbers would be meaningless.",
      ).toBe(false);
      return `profile D: control fetch to ${PROBE_PATH} failed to connect (network is genuinely gone)`;
    }

    const browserProbe = await page.evaluate(async (url) => {
      const started = performance.now();
      await fetch(url, { cache: "no-store" });
      return performance.now() - started;
    }, probeUrl);

    const nodeStart = performance.now();
    await fetch(`${proxy.origin}${PROBE_PATH}?nonce=node-${Date.now()}`, { cache: "no-store" });
    const nodeProbe = performance.now() - nodeStart;

    // 5% tolerance only for timer granularity, never enough to hide a missing
    // delay: a bypassed delay reads as single-digit milliseconds.
    const floor = profile.delayMs * 0.95;
    expect(
      browserProbe,
      `Profile ${profile.id} configures a ${profile.delayMs}ms delay, but an uncached ` +
        `request from the browser returned in ${round(browserProbe)}ms. The delay is not ` +
        "biting, so this profile is a copy of 'fast' wearing a different label.",
    ).toBeGreaterThanOrEqual(floor);
    expect(
      nodeProbe,
      `Profile ${profile.id}: the proxy itself did not apply its ${profile.delayMs}ms delay.`,
    ).toBeGreaterThanOrEqual(floor);

    return (
      `profile ${profile.id}: control fetch paid ${round(browserProbe)}ms in the browser and ` +
      `${round(nodeProbe)}ms from node against a configured ${profile.delayMs}ms delay`
    );
  } finally {
    await page.close();
  }
}

// ------------------------------------------------------------ persistence
/**
 * Re-proves, before every profile, that the persistent context still holds the
 * things that make a warm launch warm. If this silently broke, every "launch"
 * below would be a first install and the harness would be measuring the wrong
 * thing while still producing a plausible table.
 */
async function proveContextPersisted(
  context: BrowserContext,
  proxy: LatencyProxy,
  label: string,
): Promise<string> {
  const page = await context.newPage();
  try {
    await page.goto(`${proxy.origin}/library`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 20_000,
    });
    const state = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const cacheKeys = await caches.keys();
      const cachedShellEntries = await Promise.all(
        cacheKeys.map(async (key) => (await (await caches.open(key)).keys()).length),
      );
      const databases = (await indexedDB.databases?.()) ?? [];
      return {
        controller: navigator.serviceWorker.controller?.scriptURL ?? null,
        registrationScript: registration?.active?.scriptURL ?? null,
        cacheKeys,
        cachedEntries: cachedShellEntries.reduce((sum, n) => sum + n, 0),
        databases: databases.map((entry) => `${entry.name}@${entry.version}`),
      };
    });
    // Read from the context, not document.cookie: the session cookie is
    // httpOnly, so the page cannot see the very cookie whose survival matters.
    const cookies = await context.cookies();
    const sessionCookie = cookies.find((cookie) => cookie.name.includes("session"));

    expect(state.controller, `${label}: no service worker is controlling the page`).toContain(
      "/sw.js",
    );
    expect(
      state.registrationScript,
      `${label}: the service worker registration did not survive into this launch, so the ` +
        "persistent context is not persisting and every launch is really a cold launch",
    ).toContain("/sw.js");
    expect(state.cachedEntries, `${label}: Cache Storage is empty`).toBeGreaterThan(0);
    expect(
      sessionCookie,
      `${label}: the signed-in session cookie did not survive into this launch`,
    ).toBeTruthy();

    return (
      `${label}: controller=${state.controller} registration=${state.registrationScript} ` +
      `caches=[${state.cacheKeys.join(", ")}] entries=${state.cachedEntries} ` +
      `idb=[${state.databases.join(", ")}] ` +
      `cookies=${cookies.length} (session cookie "${sessionCookie?.name}" present)`
    );
  } finally {
    await page.close();
  }
}

// ------------------------------------------------------------------ reporting
function renderTable(results: ProfileResult[]): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("=".repeat(112));
  lines.push("HARK LAUNCH BENCHMARK — time from launch to REAL library content on screen");
  lines.push(
    `library size: ${bookCount} books · database host: ${databaseHost} · ` +
      `launches per profile: ${LAUNCHES_PER_PROFILE} · start_url: ${START_URL_PATH}`,
  );
  lines.push(engineNote);
  lines.push(
    `bars: p95 <= ${P95_BAR_MS}ms on every profile · spread(p95) <= ${SPREAD_BAR_MS}ms · ` +
      "zero server document hits · zero Postgres queries",
  );
  lines.push("=".repeat(112));
  lines.push(
    [
      "profile".padEnd(24),
      "p50".padStart(9),
      "p95".padStart(9),
      "max".padStart(9),
      "timeouts".padStart(9),
      "doc hits".padStart(9),
      "api hits".padStart(9),
      "asset".padStart(7),
      "queries".padStart(8),
    ].join(" "),
  );
  lines.push("-".repeat(112));

  for (const result of results) {
    const times = result.launches.map((launch) => launch.ms);
    const timeouts = result.launches.filter((launch) => launch.timedOut).length;
    const sum = (pick: (launch: Launch) => number) =>
      result.launches.reduce((total, launch) => total + pick(launch), 0);
    lines.push(
      [
        `${result.profile.id} ${result.profile.label}`.padEnd(24),
        `${round(percentile(times, 0.5))}ms`.padStart(9),
        `${round(percentile(times, 0.95))}ms`.padStart(9),
        `${round(Math.max(...times))}ms`.padStart(9),
        String(timeouts).padStart(9),
        String(sum((launch) => launch.hits.document)).padStart(9),
        String(sum((launch) => launch.hits.api)).padStart(9),
        String(sum((launch) => launch.hits.asset)).padStart(7),
        String(sum((launch) => launch.queries)).padStart(8),
      ].join(" "),
    );
  }
  lines.push("-".repeat(112));

  const p95s = results.map((result) =>
    percentile(
      result.launches.map((l) => l.ms),
      0.95,
    ),
  );
  if (p95s.length && p95s.every((value) => Number.isFinite(value))) {
    lines.push(
      `spread of p95 across profiles: ${round(Math.max(...p95s) - Math.min(...p95s))}ms ` +
        `(bar ${SPREAD_BAR_MS}ms)`,
    );
  }
  // The reported number is wall clock measured in Node, which also carries
  // Playwright's own round-trip. The in-page figure is what the browser itself
  // saw between navigation start and the marker landing. Printing the gap stops
  // anyone having to wonder how much of the budget the harness ate.
  const overheads = results
    .flatMap((result) => result.launches)
    .filter((launch) => launch.inPageMs !== null && !launch.timedOut)
    .map((launch) => launch.ms - (launch.inPageMs as number));
  if (overheads.length) {
    lines.push(
      `harness overhead (node wall clock minus in-page performance.now at marker): ` +
        `p50 ${round(percentile(overheads, 0.5))}ms · p95 ${round(percentile(overheads, 0.95))}ms ` +
        `over ${overheads.length} launches`,
    );
  }
  lines.push("");
  lines.push(
    "Per-launch detail (ms [in-page ms] · marker · doc/api/asset server hits · postgres queries):",
  );
  for (const result of results) {
    const detail = result.launches
      .map(
        (launch) =>
          `${round(launch.ms)}${launch.timedOut ? "!" : ""}` +
          `[${launch.inPageMs === null ? "-" : round(launch.inPageMs)}]` +
          `/${launch.readyKind ?? "none"}/` +
          `${launch.hits.document}-${launch.hits.api}-${launch.hits.asset}/${launch.queries}q`,
      )
      .join("  ");
    lines.push(`  ${result.profile.id}: ${detail}`);
  }
  lines.push("  (! = the readiness marker never appeared within " + `${LAUNCH_TIMEOUT_MS}ms;`);
  lines.push(
    "     that launch is recorded AT the timeout, which is a LOWER BOUND on its real cost)",
  );
  lines.push("");
  lines.push("Profile-armed self-checks:");
  for (const result of results) lines.push(`  ${result.armedEvidence}`);
  lines.push("");
  lines.push("Persistent-context proof (re-checked before each profile):");
  for (const result of results) lines.push(`  ${result.persistenceEvidence}`);
  lines.push("=".repeat(112));
  return lines.join("\n");
}

// ----------------------------------------------------------------------- run
test.beforeAll(async () => {
  expect(
    account.email && account.password,
    "HARK_TEST_ACCOUNT_EMAIL and HARK_TEST_ACCOUNT_PASSWORD must be set in .env.test",
  ).toBeTruthy();
  console.log(`[launch-benchmark] env file: ${envFile} · DATABASE_URL host: ${databaseHost}`);
  bookCount = await ensureRealisticLibrary();
  console.log(`[launch-benchmark] benchmark library: ${bookCount} books`);
  expect(
    bookCount,
    `The benchmark library holds ${bookCount} books but the bar is only meaningful against a ` +
      `realistic library of at least ${MIN_BOOKS}. A small library makes both the render and any ` +
      "local read trivially fast, so the 500ms bar would stop meaning anything.",
  ).toBeGreaterThanOrEqual(MIN_BOOKS);
});

test("library paints real content in under 500ms on every network profile", async () => {
  const engine = await selectEngine();
  engineNote =
    `engine: ${engine.name} persistent context (iPhone 15 emulation)` +
    (engine.name === "webkit" ? "" : " — NOT WebKit; see capability probe below");
  for (const line of engine.evidence) console.log(`[launch-benchmark] engine probe · ${line}`);
  if (engine.name !== "webkit") {
    console.log(
      "[launch-benchmark] WARNING: WebKit's persistent context cannot read back from Cache " +
        "Storage in this Playwright build, so the launch path is measured on Chromium with " +
        "iPhone emulation. iOS-engine fidelity of the launch path is NOT covered by this run.",
    );
  }

  const userDataDir = mkdtempSync(path.join(tmpdir(), "hark-launch-"));
  const proxy = await startLatencyProxy(appOrigin);
  const results: ProfileResult[] = [];
  let context: BrowserContext | null = null;

  try {
    // One persistent context for the whole run. A fresh newContext() per launch
    // would throw away exactly the state that makes a warm launch fast.
    context = await engine.browserType.launchPersistentContext(userDataDir, {
      ...devices["iPhone 15"],
      serviceWorkers: "allow",
    });
    // iOS sets this only when Safari launches the site from the Home Screen
    // icon, which is the launch this benchmark is about.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    });

    proxy.setDelay(0);
    const setup: Page = await context.newPage();
    await setup.goto(`${proxy.origin}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await setup.getByLabel("Email").fill(account.email);
    await setup.getByLabel("Password").fill(account.password);
    await setup.getByRole("button", { name: "Sign in" }).click();
    await setup.waitForURL(/\/library/, { timeout: 60_000 });
    await expect(setup.locator("[data-launch-ready]")).toBeAttached({ timeout: 60_000 });

    // Let the service worker install, activate and take control. Nothing is
    // measured until it is genuinely in charge of this origin: an installing or
    // redundant worker serves nothing, and every "warm" launch would silently
    // be a cold one.
    await expect
      .poll(
        () =>
          setup.evaluate(async () => {
            const registration = await navigator.serviceWorker.getRegistration("/");
            return registration?.active?.state ?? "none";
          }),
        {
          timeout: 60_000,
          message: "The service worker never reached the activated state after sign-in.",
        },
      )
      .toBe("activated");
    await setup.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await setup.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 60_000,
    });
    const controller = await setup.evaluate(
      () => navigator.serviceWorker.controller?.scriptURL ?? null,
    );
    expect(
      controller,
      "No service worker is controlling the page after sign-in, so nothing below would be a warm launch.",
    ).toContain("/sw.js");
    console.log(`[launch-benchmark] service worker controlling: ${controller}`);
    await setup.close();

    // One unmeasured launch so the shell's static assets are in Cache Storage.
    // Every measured launch below is therefore a warm launch, which is the case
    // the mission's bar is about.
    await measureLaunch(context, proxy, `${proxy.origin}${START_URL_PATH}`);

    for (const profile of PROFILES) {
      // Persistence and armed-ness are checked with the network in its normal
      // state, then the profile is applied.
      proxy.setDelay(0);
      const persistenceEvidence = await proveContextPersisted(
        context,
        proxy,
        `before profile ${profile.id}`,
      );

      proxy.setDelay(profile.delayMs);
      const abortEverything = (route: Route) => route.abort("internetdisconnected");
      if (profile.offline) {
        // setOffline(true) makes WebKit throw "internal error" on navigation
        // even when the service worker could answer from cache; aborting routes
        // removes the network while leaving the service worker able to serve.
        await context.route("**/*", abortEverything);
      }

      const armedEvidence = await proveProfileArmed(context, proxy, profile);

      const launches: Launch[] = [];
      for (let index = 0; index < LAUNCHES_PER_PROFILE; index += 1) {
        launches.push(await measureLaunch(context, proxy, `${proxy.origin}${START_URL_PATH}`));
      }

      if (profile.offline) await context.unroute("**/*", abortEverything);
      results.push({ profile, launches, armedEvidence, persistenceEvidence });
    }
  } finally {
    // The numbers are the deliverable, so they are printed whatever happened.
    if (results.length) console.log(renderTable(results));
    await context?.close();
    await proxy.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  expect(results.length, "not every profile ran").toBe(PROFILES.length);

  for (const result of results) {
    const label = `profile ${result.profile.id} ${result.profile.label}`;
    const times = result.launches.map((launch) => launch.ms);
    const p95 = percentile(times, 0.95);

    expect
      .soft(
        result.launches.filter((launch) => launch.timedOut).length,
        `${label}: the real library never appeared within ${LAUNCH_TIMEOUT_MS}ms on some launches`,
      )
      .toBe(0);

    for (const launch of result.launches) {
      expect
        .soft(
          launch.readyKind,
          `${label}: a launch finished without the readiness marker naming real content`,
        )
        .not.toBeNull();
    }

    // The honesty instrument. Timing cannot tell a cached document from a fast
    // one, and it passes silently when the service worker falls through to the
    // network on a cache miss. Hit counts can.
    const documentHits = result.launches.reduce((total, l) => total + l.hits.document, 0);
    expect
      .soft(
        documentHits,
        `${label}: the document was fetched from the server ${documentHits} time(s) across ` +
          `${LAUNCHES_PER_PROFILE} warm launches. A warm launch must be served from Cache ` +
          `Storage, or the network is still on the paint path. Paths: ` +
          result.launches.flatMap((l) => l.hits.documentPaths).join(", "),
      )
      .toBe(0);

    const queries = result.launches.reduce((total, l) => total + l.queries, 0);
    expect
      .soft(
        queries,
        `${label}: ${queries} Postgres queries ran during warm launches. The warm-launch ` +
          "critical paint path must issue none.",
      )
      .toBe(0);

    expect
      .soft(round(p95), `${label}: p95 is ${round(p95)}ms against a frozen ${P95_BAR_MS}ms bar`)
      .toBeLessThanOrEqual(P95_BAR_MS);
  }

  const p95s = results.map((result) =>
    percentile(
      result.launches.map((l) => l.ms),
      0.95,
    ),
  );
  const spread = Math.max(...p95s) - Math.min(...p95s);
  expect
    .soft(
      round(spread),
      `spread between the slowest and fastest profile p95 is ${round(spread)}ms against a frozen ` +
        `${SPREAD_BAR_MS}ms bar. The network must not change what launch costs.`,
    )
    .toBeLessThanOrEqual(SPREAD_BAR_MS);
});
