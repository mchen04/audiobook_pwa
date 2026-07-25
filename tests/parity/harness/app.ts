import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { devices } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertLocalDatabase } from "../../../scripts/lib/assert-local-database.mjs";
import { DEFAULT_TEST_ENV_FILE, loadEnvFile } from "../../../scripts/lib/env-file.mjs";
// Reused, not re-implemented: the sync suite already owns the local-database
// connection, the account reset, and the bundler that puts the SHIPPING sync
// engine into a page. Copying any of them here would give this suite a second
// definition of the product to be wrong about.
import { buildDriverScript } from "../../sync/harness/driver-bundle";
// Type-only, and load-bearing: it is what declares `window.__harkSync` for the
// pages this harness injects the driver into.
import type {} from "../../sync/harness/driver-entry";
import { closeSql, resetAccount, sql } from "../../sync/harness/app";

import { startControllableNetwork, type ControllableNetwork } from "./network";

/**
 * Setup for the parity and privacy suite. No assertion about the product lives
 * in this file except the ones that keep the harness honest — that the network
 * really is gone, that a service worker really is in charge, and that a page
 * really is showing the account it claims to.
 */

const envFile = process.env.HARK_ENV_FILE ?? DEFAULT_TEST_ENV_FILE;
loadEnvFile(envFile);

export const DATABASE_HOST = assertLocalDatabase(process.env.DATABASE_URL, {
  context: "The parity suite",
});

/** Where the app actually listens. The browser never talks to it directly. */
const APP_ORIGIN = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";

export { closeSql, resetAccount, sql };

// ---------------------------------------------------------------------------
// The controllable network
// ---------------------------------------------------------------------------

let networkPromise: Promise<ControllableNetwork> | null = null;

/**
 * One proxy per worker. Every spec in this project shares it, so they also
 * share an origin — which is what lets a warm profile built by one page be
 * reused by the next, since Cache Storage, IndexedDB and the service worker
 * registration are all keyed by origin.
 */
export function network(): Promise<ControllableNetwork> {
  networkPromise ??= startControllableNetwork(APP_ORIGIN);
  return networkPromise;
}

export async function origin(): Promise<string> {
  return (await network()).origin;
}

/**
 * Removes the network and PROVES it, twice over: a control request from inside
 * the page must fail to connect, and nothing may reach the app server while it
 * is meant to be gone.
 *
 * The control request targets `/api/`, which `public/sw.js` explicitly does not
 * intercept, so a success would mean the socket really carried it rather than a
 * worker having answered from cache.
 */
export async function cutNetwork(page: Page): Promise<void> {
  const net = await network();
  net.cut();
  const reached = await controlFetch(page, net.origin);
  expect(
    reached,
    "cutNetwork() was asked to remove the network but a control request still reached the " +
      "server. Every offline assertion after this point would be a lie.",
  ).toBe(false);
}

export async function restoreNetwork(page: Page): Promise<void> {
  const net = await network();
  net.restore();
  const reached = await controlFetch(page, net.origin);
  expect(reached, "restoreNetwork() left the network unreachable").toBe(true);
}

async function controlFetch(page: Page, netOrigin: string): Promise<boolean> {
  return page.evaluate(async (target) => {
    try {
      const response = await fetch(`${target}/api/sync/pull?control=1`, { cache: "no-store" });
      return response.status > 0;
    } catch {
      return false;
    }
  }, netOrigin);
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export type Account = { email: string; password: string; name: string; userId: string };

type AccountSpec = Omit<Account, "userId">;

export const ACCOUNT_A: AccountSpec = {
  email: "parity-a@hark.test",
  password: "Hark-Parity-Account-A-2026!",
  name: "Parity A",
};

export const ACCOUNT_B: AccountSpec = {
  email: "parity-b@hark.test",
  password: "Hark-Parity-Account-B-2026!",
  name: "Parity B",
};

/**
 * `better-auth` rate-limits `/sign-up/email` to 5 per 10 minutes and
 * `/sign-in/email` to 8 per minute (`src/server/auth.ts`), per running server
 * process. This suite stays inside both without ever loosening an assertion, in
 * three ways:
 *
 *  1. TWO accounts for the whole suite, registered the first time this database
 *     sees them and reused forever after. `ensureAccount` checks the `user`
 *     table before it registers, so a second run costs zero sign-ups.
 *  2. Specs that do not need the sign-in code path to RUN adopt a cached
 *     `storageState` instead of signing in. Only the privacy gate — where the
 *     purge hook firing is the thing under test — signs in for real.
 *  3. The real sign-ins that remain go through `signInThroughUi`, which keeps a
 *     rolling window ON DISK — so a fresh Playwright worker and a second run a
 *     minute later inherit it — spends at most five of the eight per minute, and
 *     waits the window out and retries if it is throttled anyway. A limiter that
 *     will not clear is still surfaced explicitly, so a throttled run reads as a
 *     harness problem and never as a product failure.
 */
const SIGN_IN_WINDOW_MS = 60_000;
/**
 * Five, against the limiter's eight. The remaining three are headroom for the
 * other suites that share this server — and for the retry below.
 */
const SIGN_IN_BUDGET = 5;
/**
 * The window is kept ON DISK, not in memory.
 *
 * Playwright starts a fresh worker after every failing test and re-runs this
 * module from scratch, and back-to-back runs share one app process. An
 * in-memory counter forgets both, while `better-auth`'s limiter — which lives
 * in the server, not here — remembers. Persisting it is what stops a second run
 * inside a minute from being throttled and reported as product failure.
 */
const SIGN_IN_LOG = path.join(tmpdir(), "hark-parity-signins.json");

function readSignInLog(): number[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(SIGN_IN_LOG, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "number") : [];
  } catch {
    return [];
  }
}

function writeSignInLog(times: number[]): void {
  try {
    writeFileSync(SIGN_IN_LOG, JSON.stringify(times), "utf8");
  } catch {
    // Losing the log only costs a throttled attempt, which retries below.
  }
}

async function awaitSignInBudget(): Promise<void> {
  for (;;) {
    const now = Date.now();
    const times = readSignInLog().filter((at) => now - at <= SIGN_IN_WINDOW_MS);
    if (times.length < SIGN_IN_BUDGET) {
      writeSignInLog([...times, now]);
      return;
    }
    const waitMs = SIGN_IN_WINDOW_MS - (now - times[0]!) + 750;
    console.log(`[parity] pausing ${Math.ceil(waitMs / 1000)}s to stay inside the sign-in limit`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/** Marks the window as spent, so the next attempt waits a full one out. */
function burnSignInWindow(): void {
  const now = Date.now();
  writeSignInLog(Array.from({ length: SIGN_IN_BUDGET }, () => now));
}

export async function findUserId(email: string): Promise<string | null> {
  const [row] = await sql()<{ id: string }[]>`
    SELECT id FROM "user" WHERE lower(email) = ${email.toLowerCase()}
  `;
  return row?.id ?? null;
}

/** Registers the account if this database has never seen it. */
export async function ensureAccount(browser: Browser, spec: AccountSpec): Promise<Account> {
  const existing = await findUserId(spec.email);
  if (existing) return { ...spec, userId: existing };

  const net = await network();
  const context = await browser.newContext({ ...devices["iPhone 15"], serviceWorkers: "allow" });
  try {
    const page = await context.newPage();
    await page.goto(`${net.origin}/register`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Name").fill(spec.name);
    await page.getByLabel("Email").fill(spec.email);
    await page.getByLabel(/Password/).fill(spec.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL(/\/library/, { timeout: 60_000 }).catch(async (error: unknown) => {
      await failOnRateLimit(page, "sign-up");
      throw error;
    });
  } finally {
    await context.close();
  }
  const userId = await findUserId(spec.email);
  expect(userId, `no user row for ${spec.email} after registering`).toBeTruthy();
  return { ...spec, userId: userId! };
}

async function sawRateLimit(page: Page): Promise<boolean> {
  const body = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  return body.includes("Too many requests");
}

function rateLimitError(what: string): Error {
  return new Error(
    `better-auth rate-limited the ${what} for the parity suite, and waiting a full window out ` +
      "did not clear it. This is the harness hitting `src/server/auth.ts` limits, not a product " +
      "failure: something else is signing in against this server, or restart it (the limiter " +
      "is in memory).",
  );
}

async function failOnRateLimit(page: Page, what: string): Promise<void> {
  if (await sawRateLimit(page)) throw rateLimitError(what);
}

/**
 * A real sign-in, through the real form, so `authClient`'s `onSuccess` hook —
 * and therefore `purgeOnSignIn` — actually runs. This is the only way the
 * privacy gate may authenticate.
 */
export async function signInThroughUi(page: Page, account: Account): Promise<void> {
  const net = await network();
  const attempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    await awaitSignInBudget();
    await page.goto(`${net.origin}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    const landed = await page.waitForURL(/\/library/, { timeout: 45_000 }).then(
      () => true,
      () => false,
    );
    if (landed) break;
    const throttled = await sawRateLimit(page);
    if (!throttled) {
      throw new Error(
        `signing ${account.email} in never reached /library. The page is at ${page.url()}.`,
      );
    }
    if (attempt >= attempts) throw rateLimitError("sign-in");
    // Waiting the limiter out is a harness concern, not a product one: nothing
    // below is relaxed, the attempt is simply made again once it is allowed.
    console.log("[parity] better-auth throttled a sign-in; waiting its window out and retrying");
    burnSignInWindow();
  }
  await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
  // The purge hook is fired from `onSuccess` and awaited nowhere the test can
  // see, so the sweep is given the moment it needs before anything is read.
  await page.waitForTimeout(750);
  await expectActiveUser(page, account.userId);
}

/**
 * A real sign-out, through the real control. `/library` is served cache-first
 * so its shell never carries an account menu; `/settings` is network-first and
 * server-rendered, which is where the signed-in chrome actually lives.
 */
export async function signOutThroughUi(page: Page): Promise<void> {
  const net = await network();
  await page.goto(`${net.origin}/settings`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Sign out/ }).click();
  await page.waitForURL(/\/login/, { timeout: 60_000 });
  await page.waitForTimeout(750);
}

/**
 * Ends the session server-side WITHOUT the client ever learning about it — the
 * crash between sign-out and sign-in that `docs/local-first.md` section 11 says
 * the sign-in purge exists to cover. `authClient`'s `onSuccess` hook is not on
 * this path, so no purge runs and the next sign-in inherits the mess.
 */
export async function endSessionWithoutPurge(page: Page): Promise<void> {
  const net = await network();
  const status = await page.evaluate(async (target) => {
    const response = await fetch(`${target}/api/auth/sign-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return response.status;
  }, net.origin);
  expect(status, "the raw sign-out request did not succeed").toBeLessThan(400);
}

export async function expectActiveUser(page: Page, userId: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("chapterline:active-user")), {
      timeout: 20_000,
      message: "the device never recorded the account it is signed into",
    })
    .toBe(userId);
}

/** Cached cookies, so specs that are not testing sign-in never pay for one. */
const SESSION_CACHE = path.join(tmpdir(), "hark-parity-session-a.json");

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

let cachedState: StorageState | null = null;

export async function sessionFor(browser: Browser, account: Account): Promise<StorageState> {
  if (cachedState && (await stateWorks(browser, cachedState))) return cachedState;
  const onDisk = readCachedState();
  if (onDisk && (await stateWorks(browser, onDisk))) {
    cachedState = onDisk;
    return onDisk;
  }
  const context = await browser.newContext({ ...devices["iPhone 15"], serviceWorkers: "allow" });
  try {
    const page = await context.newPage();
    await signInThroughUi(page, account);
    cachedState = await context.storageState();
    try {
      writeFileSync(SESSION_CACHE, JSON.stringify(cachedState), "utf8");
    } catch {
      // A cache miss only costs another sign-in; never a correctness issue.
    }
    return cachedState;
  } finally {
    await context.close();
  }
}

function readCachedState(): StorageState | null {
  if (!existsSync(SESSION_CACHE)) return null;
  try {
    return JSON.parse(readFileSync(SESSION_CACHE, "utf8")) as StorageState;
  } catch {
    return null;
  }
}

async function stateWorks(browser: Browser, state: StorageState): Promise<boolean> {
  const net = await network();
  const context = await browser.newContext({ storageState: state });
  try {
    const response = await context.request.get(`${net.origin}/api/sync/pull`);
    return response.status() === 200;
  } catch {
    return false;
  } finally {
    await context.close();
  }
}

/** Deletes the account's session rows, the way a revoked session dies. */
export async function revokeSessions(userId: string): Promise<number> {
  const rows = await sql()`DELETE FROM "session" WHERE user_id = ${userId} RETURNING id`;
  return rows.length;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export type Device = { context: BrowserContext; page: Page; origin: string };

/**
 * One physical device: its own IndexedDB, Cache Storage and service worker,
 * pointed at the controllable network rather than at the app server.
 *
 * `withDriver` injects the SHIPPING sync engine as `window.__harkSync`, using
 * the sync suite's own bundler. It is only ever used to journal a mutation that
 * has no UI call site yet — never to read anything this suite asserts on.
 */
export async function openDevice(
  browser: Browser,
  options: { storageState?: StorageState; deviceId?: string; withDriver?: boolean } = {},
): Promise<Device> {
  const net = await network();
  const context = await browser.newContext({
    ...devices["iPhone 15"],
    serviceWorkers: "allow",
    baseURL: net.origin,
    storageState: options.storageState,
  });
  if (options.deviceId) {
    await context.addInitScript(
      ([id]) => {
        try {
          localStorage.setItem("chapterline:device-id", id as string);
        } catch {
          // A page served before storage is available still gets the rest.
        }
      },
      [options.deviceId] as const,
    );
  }
  if (options.withDriver) {
    await context.addInitScript({ content: await buildDriverScript() });
  }
  // iOS sets this only when Safari launches the site from the Home Screen icon,
  // which is the launch the parity gates are about.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
  });
  const page = await context.newPage();
  return { context, page, origin: net.origin };
}

/**
 * Waits until a service worker genuinely controls the page.
 *
 * Nothing offline in this suite means anything until this is true: an
 * uncontrolled page simply fails to navigate with the network gone, and the
 * "offline library" would be a browser error screen.
 */
export async function warmUp(page: Page): Promise<string> {
  const net = await network();
  await page.goto(`${net.origin}/library`, { waitUntil: "domcontentloaded" });
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration("/");
          return registration?.active?.state ?? "none";
        }),
      { timeout: 60_000, message: "the service worker never reached the activated state" },
    )
    .toBe("activated");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 60_000,
  });
  await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
  const controller = await page.evaluate(
    () => navigator.serviceWorker.controller?.scriptURL ?? null,
  );
  expect(controller, "no service worker is controlling the page").toContain("/sw.js");
  return controller!;
}

/** Imports an MP3 through the real hidden file input the library renders. */
export async function importThroughUi(page: Page, name: string, buffer: Buffer): Promise<void> {
  await page.setInputFiles('input[aria-label="Choose an MP3 file to import"]', {
    name,
    mimeType: "audio/mpeg",
    buffer,
  });
}

/** A same-origin API call made by the page, so it carries the session cookie. */
export async function apiCall(
  page: Page,
  method: string,
  path_: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ([verb, target, payload]) => {
      const response = await fetch(target as string, {
        method: verb as string,
        headers: payload === null ? undefined : { "Content-Type": "application/json" },
        body: payload === null ? undefined : (payload as string),
        cache: "no-store",
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: response.status, body: parsed };
    },
    [method, path_, body === undefined ? null : JSON.stringify(body)] as const,
  );
}
