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
import { awaitSignInBudget } from "../shared/sign-in-budget";

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
 * Seven things guard the number:
 *   1. The library is seeded to a realistic size and the size is asserted, so a
 *      two-book library can never make the bar trivial.
 *   2. Every measured launch closes the browser process and relaunches
 *      `launchPersistentContext` against the SAME user data dir, and the
 *      service worker's survival is re-proved (in a freshly relaunched process)
 *      before each profile. The profile stays warm; the process does not. That
 *      is what an iOS Home-Screen tap actually is: iOS kills backgrounded PWAs,
 *      so nearly every real launch pays a browser start and a service-worker
 *      cold start. A single long-lived context excludes both.
 *   3. Server hit counts, not timings, decide whether the document came from
 *      cache. A fast server and a cached document look identical on a clock.
 *   4. Each delayed profile proves its delay actually bit, and the offline
 *      profile proves the network really is gone, before its launches count.
 *   5. The CPU is throttled, and the throttle is proved to have engaged by
 *      timing a fixed CPU-bound loop with it on and off. `devices["iPhone 15"]`
 *      sets viewport, user agent, device pixel ratio and touch — it does not
 *      touch CPU, and almost every millisecond of a warm launch is device-local
 *      CPU work.
 *   6. What was PAINTED is asserted, not just that some marker appeared. The
 *      app sets `data-launch-ready="empty"` on the "Bring your first audiobook"
 *      screen, so a mirror that was never synced, or was evicted or purged,
 *      paints an empty box in ~0ms and would otherwise report a superb number
 *      with zero queries. Every launch on this 1000-book account must report
 *      the "books" marker AND a counted, non-zero number of rendered book
 *      cards, captured inside the page in the same tick the marker lands.
 *   7. The reported number is wall clock measured in Node, which over-reports.
 *      The in-page figure is printed beside every launch.
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
/**
 * Every rendered book card. The library renders `PAGE_SIZE` of them into
 * `.book-grid` in the same React commit that sets `data-launch-ready="books"`,
 * so counting them at the marker is counting what the user is looking at.
 */
const BOOK_CARD_SELECTOR = ".book-grid .book-item";

/**
 * CPU throttling rate applied to every measured launch, via CDP
 * `Emulation.setCPUThrottlingRate`.
 *
 * Why any rate at all: the path this benchmark measures is almost entirely
 * device-local CPU — hydrate React, open IndexedDB, `getAll` a thousand books
 * plus playback states plus tag edges plus tags, filter and sort them in JS,
 * render the cards. None of that is network. Run unthrottled on an M-series
 * Mac, the resulting number has no defensible mapping to the phone in the
 * owner's hand, and the 500ms bar is being cleared by hardware the owner does
 * not have.
 *
 * Why 4x: it is the rate Chrome DevTools and Lighthouse use for their default
 * "mobile" emulation, chosen to approximate a mid-tier phone against a
 * developer laptop. It is a convention rather than a measurement of any one
 * handset — a modern iPhone is faster than 4x-slowdown implies and a budget
 * Android is slower — but it is the published, widely-agreed default, so it is
 * the honest choice for a number nobody is going to re-derive. It is NOT tuned
 * to whatever makes the bar pass; see `proveCpuThrottled`, which fails the run
 * if the throttle silently did not engage.
 */
const CPU_THROTTLE_RATE = 4;

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
  /** The marker attribute, read back over the wire after the wait. */
  readyKind: string | null;
  /** The marker attribute as it was in the tick the marker landed, in-page. */
  paintedKind: string | null;
  /** Book cards on screen in that same tick. Null only if the marker never came. */
  cards: number | null;
  inPageMs: number | null;
  /**
   * How the browser says the launch document was delivered, and how many bytes
   * came over the wire for it. This separates two things a server hit count
   * alone cannot: "the paint came off the network" and "the paint came out of
   * Cache Storage while the browser also spoke to the server".
   */
  deliveredBy: string | null;
  transferSize: number | null;
  /** Cost of closing the previous browser process and starting a new one. */
  relaunchMs: number;
  hits: ProxyReport;
  queries: number;
};

type ProfileResult = {
  profile: Profile;
  launches: Launch[];
  armedEvidence: string;
  persistenceEvidence: string;
};

/** What the page recorded about itself at the moment the marker landed. */
type PaintRecord = {
  ms: number;
  kind: string | null;
  cards: number;
  deliveredBy: string | null;
  transferSize: number | null;
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
let cpuThrottleEvidence = "(not measured)";

// ------------------------------------------------------------ engine choice
/**
 * The benchmark is about a document served cache-first out of Cache Storage,
 * across launches, in a persistent profile, on a phone's CPU. Two capabilities
 * are therefore not optional:
 *
 *   - Cache Storage read-back in a persistent context. An engine that cannot do
 *     it cannot host the measurement at all: the harness would stay red no
 *     matter how correct the app became, which is just a different way of
 *     measuring nothing.
 *   - CPU throttling. The measured path is almost entirely device-local CPU, so
 *     an engine that runs it at full desktop speed produces a number with no
 *     mapping to the owner's phone. That is a pleasant fiction, not a result.
 *
 * So the engine is chosen by capability, not by preference, and the choice is
 * printed. WebKit is tried first because iOS Safari is the target; Chromium is
 * used only if WebKit fails a probe, and that fallback is stated loudly
 * wherever the numbers appear.
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
    let cpuThrottling = "not reached";
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
        cpuThrottling = await context
          .newCDPSession(page)
          .then(async (session) => {
            await session.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE_RATE });
            await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
            await session.detach();
            return "accepted";
          })
          .catch((error: unknown) => `refused (${String(error).split("\n")[0]})`);
      } finally {
        await context.close();
      }
    } catch (error) {
      failure = String(error).split("\n")[0] ?? "";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const capable = readBack === "probe-body" && cpuThrottling === "accepted";
    evidence.push(
      `${name} persistent context: Cache Storage read-back = ${JSON.stringify(readBack)}, ` +
        `Emulation.setCPUThrottlingRate = ${cpuThrottling}` +
        (failure ? ` (${failure})` : "") +
        (capable ? " — USABLE" : " — UNUSABLE for a cache-first, CPU-throttled launch measurement"),
    );
    if (capable) return { name, browserType, evidence };
  }

  throw new Error(
    "No browser engine can both read back from Cache Storage in a persistent context and throttle " +
      "its CPU, so a cache-first launch on a phone-like CPU cannot be measured at all:\n  " +
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

// ------------------------------------------------------------ browser process
/**
 * Opens a persistent context against `userDataDir`.
 *
 * Called once per measured launch. The directory is the same every time, so the
 * service worker registration, Cache Storage, IndexedDB and cookies survive;
 * the browser process does not. That is the whole point — see note 2 at the top
 * of this file.
 */
type ContextHandle = { context: BrowserContext; relaunchMs: number };

const abortEverything = (route: Route) => route.abort("internetdisconnected");

async function openLaunchContext(
  engine: Engine,
  userDataDir: string,
  offline: boolean,
): Promise<ContextHandle> {
  const started = performance.now();
  const context = await engine.browserType.launchPersistentContext(userDataDir, {
    ...devices["iPhone 15"],
    serviceWorkers: "allow",
  });
  // iOS sets this only when Safari launches the site from the Home Screen icon,
  // which is the launch this benchmark is about. Re-applied on every relaunch,
  // because init scripts live on the context, not on the profile directory.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
  });
  // setOffline(true) makes WebKit throw "internal error" on navigation even when
  // the service worker could answer from cache; aborting routes removes the
  // network while leaving the service worker able to serve.
  if (offline) await context.route("**/*", abortEverything);
  return { context, relaunchMs: performance.now() - started };
}

// ------------------------------------------------------------- CPU throttling
/**
 * Applies CPU throttling to one page over CDP. Must be called before the
 * navigation, so that parse, hydrate, the IndexedDB reads and the render all
 * run slowed down.
 *
 * The session is deliberately not detached: detaching resets the rate.
 */
async function throttleCpu(page: Page, rate: number): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate });
}

/**
 * Proves the throttle actually engages, by timing an identical pure-CPU loop
 * with it off and on. A CDP call that silently no-ops would make this benchmark
 * worse than one that never claimed to throttle at all: it would print a
 * "throttled" table full of desktop numbers.
 */
async function proveCpuThrottled(page: Page, rate: number): Promise<string> {
  // No timers, no I/O, no allocation: a fixed amount of arithmetic, so the only
  // thing that can change its duration is how much CPU the page is given.
  const spin = () =>
    page.evaluate(() => {
      const started = performance.now();
      let accumulator = 0;
      for (let index = 0; index < 8_000_000; index += 1) accumulator += Math.sqrt(index % 977);
      return { ms: performance.now() - started, accumulator };
    });

  await spin(); // warm the JIT, so the comparison is not measuring compilation
  const free = Math.min((await spin()).ms, (await spin()).ms);

  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate });
  const throttled = Math.min((await spin()).ms, (await spin()).ms);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const restored = Math.min((await spin()).ms, (await spin()).ms);
  await session.detach();

  const observed = throttled / free;
  expect(
    observed,
    `CPU throttling was requested at ${rate}x but a fixed CPU-bound loop took ${round(free)}ms ` +
      `free and ${round(throttled)}ms throttled — a ${observed.toFixed(2)}x slowdown. The CDP ` +
      "call did not bite, so every number below would be an unthrottled desktop number wearing " +
      "a mobile label.",
  ).toBeGreaterThanOrEqual(rate * 0.6);
  expect(
    restored / free,
    `Setting the CPU throttling rate back to 1x did not restore full speed (${round(restored)}ms ` +
      `vs ${round(free)}ms free), so the throttle control is not trustworthy in either direction.`,
  ).toBeLessThan(rate * 0.6);

  return (
    `CPU throttle: a fixed 8M-iteration loop ran in ${round(free)}ms at 1x, ${round(throttled)}ms ` +
    `at ${rate}x (${observed.toFixed(2)}x slowdown observed) and ${round(restored)}ms after ` +
    `resetting to 1x — Emulation.setCPUThrottlingRate is genuinely biting`
  );
}

// -------------------------------------------------------------- one "launch"
/**
 * A launch closes the browser process and starts a new one against the same
 * user data dir, then navigates to the manifest `start_url`.
 *
 * New process = fresh document, fresh JS heap, fresh paint, and a service
 * worker that has to be woken from disk rather than one that has been resident
 * the whole time. Same user data dir = the service worker registration, Cache
 * Storage, IndexedDB and cookies that a real second launch would still have.
 *
 * The clock starts at the navigation, not at `launchPersistentContext`. The
 * browser-spawn cost is measured and printed separately (`relaunchMs`) but kept
 * out of the reported number, because Playwright's Chromium spawn plus its CDP
 * handshake is a harness cost and not a defensible stand-in for iOS starting
 * Safari. What the relaunch DOES buy the number is real and is included: the
 * service worker cold start now sits on the measured path.
 */
async function measureLaunch(
  engine: Engine,
  userDataDir: string,
  proxy: LatencyProxy,
  url: string,
  offline: boolean,
): Promise<Launch> {
  const handle = await openLaunchContext(engine, userDataDir, offline);
  proxy.reset();
  await readQueryCount(true);

  try {
    const page = await handle.context.newPage();
    await throttleCpu(page, CPU_THROTTLE_RATE);
    await page.addInitScript((cardSelector: string) => {
      const target = window as unknown as {
        __harkLaunch: {
          ms: number;
          kind: string | null;
          cards: number;
          deliveredBy: string | null;
          transferSize: number | null;
        } | null;
      };
      target.__harkLaunch = null;
      const found = () => {
        if (target.__harkLaunch !== null) return true;
        const marker = document.querySelector("[data-launch-ready]");
        if (!marker) return false;
        const navigation = performance.getEntriesByType("navigation")[0] as
          (PerformanceNavigationTiming & { deliveryType?: string }) | undefined;
        // Marker value AND card count are read here, in the page, in the tick
        // the marker lands. That costs no extra round trip and — unlike a
        // question asked afterwards — it cannot be answered by content that
        // only arrived later.
        target.__harkLaunch = {
          ms: performance.now(),
          kind: marker.getAttribute("data-launch-ready"),
          cards: document.querySelectorAll(cardSelector).length,
          deliveredBy: navigation?.deliveryType ?? null,
          transferSize: navigation?.transferSize ?? null,
        };
        return true;
      };
      if (!found()) {
        const observer = new MutationObserver(() => {
          if (found()) observer.disconnect();
        });
        observer.observe(document, { childList: true, subtree: true, attributes: true });
      }
    }, BOOK_CARD_SELECTOR);

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

    let painted: PaintRecord | null = null;
    if (!timedOut) {
      painted = await page
        .evaluate(() => (window as unknown as { __harkLaunch: PaintRecord | null }).__harkLaunch)
        .catch(() => null);
    }

    const queries = await readQueryCount(true);
    const hits = proxy.report();

    return {
      ms,
      timedOut,
      readyKind,
      paintedKind: painted?.kind ?? null,
      cards: painted ? painted.cards : null,
      inPageMs: painted?.ms ?? null,
      deliveredBy: painted?.deliveredBy ?? null,
      transferSize: painted?.transferSize ?? null,
      relaunchMs: handle.relaunchMs,
      hits,
      queries,
    };
  } finally {
    await handle.context.close();
  }
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
 * Re-proves, before every profile, that the persistent PROFILE still holds the
 * things that make a warm launch warm — in a browser process that was itself
 * just started against that profile directory. If this silently broke, every
 * "launch" below would be a first install and the harness would be measuring
 * the wrong thing while still producing a plausible table. Since every measured
 * launch now relaunches the process, this is also the proof that relaunching
 * does not throw the profile away.
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
    `CPU: throttled ${CPU_THROTTLE_RATE}x via Emulation.setCPUThrottlingRate · ` +
      "every measured launch is a fresh browser process against the same profile directory",
  );
  lines.push(
    `bars: p95 <= ${P95_BAR_MS}ms on every profile · spread(p95) <= ${SPREAD_BAR_MS}ms · ` +
      "zero server document hits · zero Postgres queries · every launch paints " +
      '"books" with >0 book cards',
  );
  lines.push("=".repeat(122));
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
      "marker".padStart(9),
      "cards".padStart(8),
    ].join(" "),
  );
  lines.push("-".repeat(122));

  for (const result of results) {
    const times = result.launches.map((launch) => launch.ms);
    const timeouts = result.launches.filter((launch) => launch.timedOut).length;
    const sum = (pick: (launch: Launch) => number) =>
      result.launches.reduce((total, launch) => total + pick(launch), 0);
    const markers = [...new Set(result.launches.map((launch) => launch.paintedKind ?? "none"))];
    const cardCounts = result.launches.map((launch) => launch.cards ?? 0);
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
        markers.join("/").padStart(9),
        (Math.min(...cardCounts) === Math.max(...cardCounts)
          ? String(Math.min(...cardCounts))
          : `${Math.min(...cardCounts)}-${Math.max(...cardCounts)}`
        ).padStart(8),
      ].join(" "),
    );
  }
  lines.push("-".repeat(122));

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
  // Excluded from the reported number on purpose, and printed so that the
  // exclusion is visible rather than assumed. Playwright's browser spawn plus
  // its CDP handshake is a harness cost; iOS starting Safari is not the same
  // thing and this is not a measurement of it.
  const relaunches = results.flatMap((result) => result.launches.map((l) => l.relaunchMs));
  if (relaunches.length) {
    lines.push(
      `browser relaunch cost EXCLUDED from the figures above (harness browser spawn, not iOS ` +
        `process start): p50 ${round(percentile(relaunches, 0.5))}ms · ` +
        `p95 ${round(percentile(relaunches, 0.95))}ms over ${relaunches.length} relaunches`,
    );
  }
  lines.push("");
  lines.push(
    "Per-launch detail (ms [in-page ms] · marker · book cards painted · how the document was " +
      "delivered:bytes over the wire · doc/api/asset server hits · postgres queries):",
  );
  for (const result of results) {
    const detail = result.launches
      .map(
        (launch) =>
          `${round(launch.ms)}${launch.timedOut ? "!" : ""}` +
          `[${launch.inPageMs === null ? "-" : round(launch.inPageMs)}]` +
          `/${launch.readyKind ?? "none"}/` +
          `${launch.cards === null ? "-" : launch.cards}cards/` +
          `${launch.deliveredBy ?? "?"}:${launch.transferSize ?? "?"}B/` +
          `${launch.hits.document}-${launch.hits.api}-${launch.hits.asset}/${launch.queries}q`,
      )
      .join("  ");
    lines.push(`  ${result.profile.id}: ${detail}`);
  }
  lines.push("  (! = the readiness marker never appeared within " + `${LAUNCH_TIMEOUT_MS}ms;`);
  lines.push(
    "     that launch is recorded AT the timeout, which is a LOWER BOUND on its real cost)",
  );
  lines.push(
    "  (Ncards = book cards counted in the page in the same tick the marker landed. 0 cards, or " +
      'any marker other than "books",',
  );
  lines.push(
    `     means the launch painted something that is NOT this account's ${bookCount}-book library.)`,
  );
  lines.push("");
  lines.push("CPU throttle proof:");
  lines.push(`  ${cpuThrottleEvidence}`);
  lines.push("");
  lines.push("Profile-armed self-checks:");
  for (const result of results) lines.push(`  ${result.armedEvidence}`);
  lines.push("");
  lines.push("Persistent-profile proof (re-checked in a freshly relaunched process, per profile):");
  for (const result of results) lines.push(`  ${result.persistenceEvidence}`);
  lines.push("=".repeat(122));
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
      "[launch-benchmark] WARNING: WebKit's persistent context failed the capability probe " +
        "above, so the launch path is measured on Chromium with iPhone emulation and a 4x CPU " +
        "throttle. iOS-engine fidelity of the launch path is NOT covered by this run.",
    );
  }

  const userDataDir = mkdtempSync(path.join(tmpdir(), "hark-launch-"));
  const proxy = await startLatencyProxy(appOrigin);
  const results: ProfileResult[] = [];
  let context: BrowserContext | null = null;

  try {
    // The sign-in context. It is closed before any measurement, and every
    // measured launch starts its own process against this same directory.
    context = (await openLaunchContext(engine, userDataDir, false)).context;

    proxy.setDelay(0);
    const setup: Page = await context.newPage();
    // Shares the sign-in window with every other suite driving this server.
    await awaitSignInBudget("launch-benchmark");
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

    // Before anything is measured: prove the CPU throttle engages in this
    // engine. Done here, on a page that is about to be thrown away, so the
    // measured launches never carry the cost of proving it.
    cpuThrottleEvidence = await proveCpuThrottled(setup, CPU_THROTTLE_RATE);
    console.log(`[launch-benchmark] ${cpuThrottleEvidence}`);
    await setup.close();

    // Closing the sign-in process flushes the profile to disk. Everything below
    // reads it back from there.
    await context.close();
    context = null;

    // One unmeasured launch so the shell's static assets are in Cache Storage.
    // Every measured launch below is therefore a warm launch, which is the case
    // the mission's bar is about.
    await measureLaunch(engine, userDataDir, proxy, `${proxy.origin}${START_URL_PATH}`, false);

    for (const profile of PROFILES) {
      // Persistence and armed-ness are checked with the network in its normal
      // state, then the profile is applied. This context is itself freshly
      // launched against the same user data dir, so proving the service worker,
      // Cache Storage, IndexedDB and cookie are here is proving they survived a
      // process restart.
      proxy.setDelay(0);
      const probeContext = await openLaunchContext(engine, userDataDir, false);
      let persistenceEvidence: string;
      let armedEvidence: string;
      try {
        persistenceEvidence = await proveContextPersisted(
          probeContext.context,
          proxy,
          `before profile ${profile.id}`,
        );

        proxy.setDelay(profile.delayMs);
        if (profile.offline) await probeContext.context.route("**/*", abortEverything);
        armedEvidence = await proveProfileArmed(probeContext.context, proxy, profile);
      } finally {
        await probeContext.context.close();
      }

      const launches: Launch[] = [];
      for (let index = 0; index < LAUNCHES_PER_PROFILE; index += 1) {
        launches.push(
          await measureLaunch(
            engine,
            userDataDir,
            proxy,
            `${proxy.origin}${START_URL_PATH}`,
            profile.offline,
          ),
        );
      }

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

    // What was on screen, not merely that something was. The account owns
    // `bookCount` books — verified in Postgres in beforeAll — so the only
    // acceptable paint is the real library. `data-launch-ready="empty"` is the
    // "Bring your first audiobook" screen: a mirror that was never synced, or
    // was evicted or purged, paints it in almost no time with no queries, and
    // that is exactly the fast-and-wrong result this benchmark exists to catch.
    for (const launch of result.launches) {
      expect
        .soft(
          launch.readyKind,
          `${label}: a launch finished without the readiness marker naming real content`,
        )
        .not.toBeNull();
      expect
        .soft(
          launch.paintedKind,
          `${label}: a launch painted "${launch.paintedKind ?? "nothing"}" on an account that ` +
            `owns ${bookCount} books. Only "books" is this owner's real library; "empty" is the ` +
            '"Bring your first audiobook" screen and "preparing"/none is a placeholder. A fast ' +
            "launch that paints an empty box is not a fast launch.",
        )
        .toBe("books");
      expect
        .soft(
          launch.cards ?? 0,
          `${label}: a launch painted ${launch.cards ?? 0} book cards on an account that owns ` +
            `${bookCount} books. The marker landed but nothing of the owner's library was on ` +
            "screen.",
        )
        .toBeGreaterThan(0);
      expect
        .soft(
          launch.readyKind,
          `${label}: the marker read back over the wire ("${launch.readyKind}") disagrees with ` +
            `what the page recorded at paint time ("${launch.paintedKind}"), so the content the ` +
            "clock stopped on is not the content that was assessed.",
        )
        .toBe(launch.paintedKind);
      // The paint itself must have come out of Cache Storage with nothing on
      // the wire. This is deliberately a SEPARATE question from the server hit
      // count below: a browser can serve the page from cache and still talk to
      // the server, and the two failures have completely different causes and
      // completely different fixes.
      expect
        .soft(
          `${launch.deliveredBy}/${launch.transferSize}`,
          `${label}: the launch document was delivered by "${launch.deliveredBy}" with ` +
            `${launch.transferSize} bytes on the wire. A warm launch must paint from Cache ` +
            "Storage with an empty transfer.",
        )
        .toBe("cache-storage/0");
    }

    // The honesty instrument. Timing cannot tell a cached document from a fast
    // one, and it passes silently when the service worker falls through to the
    // network on a cache miss. Hit counts can.
    const documentHits = result.launches.reduce((total, l) => total + l.hits.document, 0);
    expect
      .soft(
        documentHits,
        `${label}: the document was fetched from the server ${documentHits} time(s) across ` +
          `${LAUNCHES_PER_PROFILE} warm launches. A warm launch must not put the document on ` +
          "the network at all. Check the delivery column first: if it says cache-storage/0B, " +
          "the PAINT was cache-served and something else — the app, or the browser speculating " +
          "around a cold service worker — still went to the server, and it still costs the " +
          "owner and the server. Paths: " +
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
