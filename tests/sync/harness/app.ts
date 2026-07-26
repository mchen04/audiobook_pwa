import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";

import { awaitSignInBudget } from "../../shared/sign-in-budget";
import { testAccountPassword } from "../../shared/test-account-password";
import { assertLocalDatabase } from "../../../scripts/lib/assert-local-database.mjs";
import { DEFAULT_TEST_ENV_FILE, loadEnvFile } from "../../../scripts/lib/env-file.mjs";

import { buildDriverScript } from "./driver-bundle";
import type { FuzzOp, MirrorSnapshot } from "./driver-entry";

/**
 * Shared plumbing for the sync suite: the local database connection, account
 * creation, and a browser context that has a DISTINCT device id and the
 * production sync engine reachable as `window.__harkSync`.
 *
 * Everything here is setup. No assertion about the product lives in this file.
 */

const envFile = process.env.HARK_ENV_FILE ?? DEFAULT_TEST_ENV_FILE;
loadEnvFile(envFile);

export const DATABASE_HOST = assertLocalDatabase(process.env.DATABASE_URL, {
  context: "The sync suite",
});

export const APP_ORIGIN = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";

let pool: ReturnType<typeof postgres> | null = null;

export function sql() {
  pool ??= postgres(process.env.DATABASE_URL as string, { max: 4 });
  return pool;
}

export async function closeSql(): Promise<void> {
  if (pool) await pool.end({ timeout: 5 });
  pool = null;
}

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export type Account = { email: string; password: string; userId: string };

/**
 * ONE account for the whole suite, reused across runs.
 *
 * `better-auth` rate-limits `/sign-up/email` to five per ten minutes and
 * `/sign-in/email` to eight per minute (`src/server/auth.ts`), so a suite that
 * registered an account per spec — let alone per fuzz seed — would spend most
 * of a run being throttled and would report that as product failure. One
 * dedicated account is registered the first time this database sees it and
 * signed into once per spec after that.
 *
 * Isolation comes from `resetAccount`, which removes every row the account owns
 * before a spec runs, and from each device starting with an empty IndexedDB.
 */
const SHARED_EMAIL = "sync-verifier@hark.test";
const SHARED_PASSWORD = testAccountPassword("sync-verifier");

let sharedStorageState: StorageState | null = null;
let sharedAccount: Account | null = null;

/**
 * Playwright starts a FRESH WORKER after every failing test, which re-runs this
 * module from scratch. Signing in each time would trip the eight-per-minute
 * limit on `/sign-in/email` and turn a red run into a red-and-unreadable one,
 * so the session is cached on disk and only re-established when it no longer
 * works.
 */
const SESSION_CACHE = path.join(tmpdir(), "hark-sync-verifier-session.json");

async function findUserId(email: string): Promise<string | null> {
  const [row] = await sql()<{ id: string }[]>`
    SELECT id FROM "user" WHERE lower(email) = ${email.toLowerCase()}
  `;
  return row?.id ?? null;
}

/** True when the cached cookies still authenticate against the running server. */
async function stillValid(browser: Browser, storageState: StorageState): Promise<boolean> {
  const context = await browser.newContext({ storageState });
  try {
    const response = await context.request.get(`${APP_ORIGIN}/api/sync/pull`);
    return response.status() === 200;
  } catch {
    return false;
  } finally {
    await context.close();
  }
}

function readCachedSession(): StorageState | null {
  if (!existsSync(SESSION_CACHE)) return null;
  try {
    return JSON.parse(readFileSync(SESSION_CACHE, "utf8")) as StorageState;
  } catch {
    return null;
  }
}

/**
 * The signed-in account plus a `storageState` a fresh context can adopt.
 *
 * Adopting the state is what lets each fuzz seed run on a brand-new device
 * (empty IndexedDB, empty Cache Storage) without paying for another sign-in.
 */
export async function sharedSession(
  browser: Browser,
): Promise<{ account: Account; storageState: StorageState }> {
  if (sharedAccount && sharedStorageState) {
    return { account: sharedAccount, storageState: sharedStorageState };
  }
  const existing = await findUserId(SHARED_EMAIL);
  const cached = existing ? readCachedSession() : null;
  if (existing && cached && (await stillValid(browser, cached))) {
    sharedAccount = { email: SHARED_EMAIL, password: SHARED_PASSWORD, userId: existing };
    sharedStorageState = cached;
    return { account: sharedAccount, storageState: sharedStorageState };
  }

  // The limiter is in the server and does not care which suite spent the
  // attempts, so this shares one on-disk window with the parity suite.
  await awaitSignInBudget("sync");
  const context = await browser.newContext({ serviceWorkers: "allow" });
  try {
    const page = await context.newPage();
    if (existing) {
      await page.goto(`${APP_ORIGIN}/login`, { waitUntil: "domcontentloaded" });
      await page.getByLabel("Email").fill(SHARED_EMAIL);
      await page.getByLabel("Password").fill(SHARED_PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
    } else {
      await page.goto(`${APP_ORIGIN}/register`, { waitUntil: "domcontentloaded" });
      await page.getByLabel("Name").fill("Sync Verifier");
      await page.getByLabel("Email").fill(SHARED_EMAIL);
      await page.getByLabel(/Password/).fill(SHARED_PASSWORD);
      await page.getByRole("button", { name: "Create account" }).click();
    }
    await page.waitForURL(/\/library/, { timeout: 60_000 }).catch(async (error: unknown) => {
      const message = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      if (message.includes("Too many requests")) {
        throw new Error(
          "better-auth rate-limited the sign-in for the shared verifier account. This is the " +
            "harness hitting `src/server/auth.ts` limits, not a product failure: wait for the " +
            "window to pass, or restart the app server (the limiter is in memory).",
        );
      }
      throw error;
    });
    await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });

    const userId = await findUserId(SHARED_EMAIL);
    expect(userId, `no user row for ${SHARED_EMAIL} after signing in`).toBeTruthy();
    sharedAccount = { email: SHARED_EMAIL, password: SHARED_PASSWORD, userId: userId! };
    sharedStorageState = await context.storageState();
    try {
      writeFileSync(SESSION_CACHE, JSON.stringify(sharedStorageState), "utf8");
    } catch {
      // A cache miss only costs another sign-in; it is never a correctness issue.
    }
    return { account: sharedAccount, storageState: sharedStorageState };
  } finally {
    await context.close();
  }
}

/**
 * Removes every row the account owns, so a spec starts from a known-empty
 * library. `books` cascades to chapters, media assets, tag edges, playback
 * state and playback actions; the rest are deleted explicitly.
 *
 * Tombstones go too: a stale one from a previous spec would tell the next
 * device to delete a book it has never seen.
 */
export async function resetAccount(userId: string): Promise<void> {
  const client = sql();
  await client`DELETE FROM books WHERE owner_id = ${userId}`;
  await client`DELETE FROM collections WHERE user_id = ${userId}`;
  await client`DELETE FROM tags WHERE user_id = ${userId}`;
  await client`DELETE FROM book_tombstones WHERE owner_id = ${userId}`;
  await client`DELETE FROM listening_sessions WHERE user_id = ${userId}`;
  await client`DELETE FROM playback_device_sequences WHERE user_id = ${userId}`;
}

/**
 * A context that behaves like one physical device.
 *
 * `chapterline:device-id` is stamped before any app script runs, which is what
 * makes two contexts two DEVICES rather than two tabs — the device id is the
 * ordering key the whole progress conflict policy is built on, and two contexts
 * that minted the same one would make the convergence tests meaningless.
 */
export async function openDevice(
  browser: Browser,
  deviceId: string,
  storageState?: StorageState,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ serviceWorkers: "allow", storageState });
  const script = await buildDriverScript();
  await context.addInitScript(
    ([id, key]) => {
      try {
        localStorage.setItem(key as string, id as string);
      } catch {
        // A page served before storage is available still gets the driver.
      }
    },
    [deviceId, "chapterline:device-id"] as const,
  );
  await context.addInitScript({ content: script });
  const page = await context.newPage();
  return { context, page };
}

/** Points the in-page driver at an account, and proves the bundle really loaded. */
export async function attachDriver(page: Page, account: Account, deviceId: string): Promise<void> {
  const ready = await page.evaluate(
    ([userId, id]) => {
      if (!window.__harkSync) return { ok: false as const };
      window.__harkSync.configure(userId, id);
      return { ok: true as const, deviceId: window.__harkSync.deviceId() };
    },
    [account.userId, deviceId] as const,
  );
  expect(
    ready.ok,
    "window.__harkSync is missing, so this page is not carrying the production sync engine and " +
      "nothing below would be testing the product.",
  ).toBe(true);
  expect(ready.ok && ready.deviceId).toBe(deviceId);
}

// ---------------------------------------------------------------------------
// Network control
// ---------------------------------------------------------------------------

/**
 * Takes the network away for real, and proves it.
 *
 * `context.route(...).abort()` is NOT enough here, and this suite must not use
 * it: once a service worker controls the page, a `fetch("/api/...")` the worker
 * declines to handle is reissued outside Playwright's interception and reaches
 * the server anyway. That was measured, not assumed — a control request came
 * back HTTP 200 with every route aborted. `context.setOffline(true)` removes
 * the network at the stack, below the worker, and the control fetch below
 * re-proves it on every transition.
 *
 * The cost is that WebKit cannot navigate at all while offline ("WebKit
 * encountered an internal error"), so every reload in this suite happens with
 * the network up. Durability of the queue across a relaunch is proved
 * separately, by restarting a persistent context, in `outbox-durability.spec.ts`.
 */
export async function goOffline(context: BrowserContext, page: Page): Promise<void> {
  await context.setOffline(true);
  const reached = await page.evaluate(async (origin) => {
    try {
      await fetch(`${origin}/api/sync/pull`, { cache: "no-store" });
      return true;
    } catch {
      return false;
    }
  }, APP_ORIGIN);
  expect(
    reached,
    "goOffline() was asked to remove the network but a control request still reached the " +
      "server. Every 'queued while offline' assertion after this point would be a lie.",
  ).toBe(false);
}

export async function goOnline(context: BrowserContext, page: Page): Promise<void> {
  await context.setOffline(false);
  const reached = await page.evaluate(async (origin) => {
    try {
      const response = await fetch(`${origin}/api/sync/pull`, { cache: "no-store" });
      return response.status;
    } catch {
      return 0;
    }
  }, APP_ORIGIN);
  expect(reached, "goOnline() left the network unreachable").toBeGreaterThan(0);
  // The reconnect path of design contract section 6: the app replays its queue
  // and pulls when this fires, and nothing else on the read path listens.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}

// ---------------------------------------------------------------------------
// Driver calls
// ---------------------------------------------------------------------------

export function commit(page: Page, op: FuzzOp) {
  return page.evaluate((value) => window.__harkSync.commit(value), op);
}

export function replay(page: Page) {
  return page.evaluate(() => window.__harkSync.replay());
}

export function outbox(page: Page) {
  return page.evaluate(() => window.__harkSync.outbox());
}

export function pull(page: Page) {
  return page.evaluate(() => window.__harkSync.pull());
}

export function mirror(page: Page): Promise<MirrorSnapshot> {
  return page.evaluate(() => window.__harkSync.mirror());
}

export function evictMirror(page: Page) {
  return page.evaluate(() => window.__harkSync.evictMirror());
}

export function evictAudio(page: Page) {
  return page.evaluate(() => window.__harkSync.evictAudio());
}

export function watchConflicts(page: Page) {
  return page.evaluate(() => window.__harkSync.watchConflicts());
}

export function observedConflicts(page: Page) {
  return page.evaluate(() => window.__harkSync.observedConflicts());
}

export function mediaCacheEntries(page: Page) {
  return page.evaluate(() => window.__harkSync.mediaCacheEntries());
}

/** Whether this device holds a download record for the book AND the bytes it names. */
export function playable(page: Page, bookId: string) {
  return page.evaluate((id) => window.__harkSync.playable(id), bookId);
}

/** Creates a collection through the shipping route and returns its server id. */
export async function createCollection(page: Page, name: string): Promise<string> {
  const created = await page.evaluate(
    async ([origin, collectionName]) => {
      const response = await fetch(`${origin}/api/collections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: collectionName }),
      });
      return { status: response.status, body: (await response.json()) as unknown };
    },
    [APP_ORIGIN, name] as const,
  );
  expect(created.status, `creating collection "${name}" failed`).toBe(201);
  return (created.body as { collection: { id: string } }).collection.id;
}

/**
 * Waits until a service worker is actually controlling the page.
 *
 * Nothing that reloads with the network removed is meaningful until this is
 * true: an uncontrolled page would simply fail to navigate, and the reload
 * would prove durability of nothing.
 */
export async function waitForServiceWorker(page: Page): Promise<void> {
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
}

/**
 * Imports an MP3 through the REAL import path: the hidden file input the
 * library renders, `local-import.ts`, `POST /api/books/local`, and
 * `media-store.ts` writing the bytes into Cache Storage.
 *
 * The audio never leaves the device on this path and this helper adds no way
 * for it to: it hands a buffer to a file input inside the browser.
 */
export async function importThroughUi(page: Page, name: string, buffer: Buffer): Promise<void> {
  await page.setInputFiles('input[aria-label="Choose an MP3 file to import"]', {
    name,
    mimeType: "audio/mpeg",
    buffer,
  });
}

/**
 * Drains the outbox to empty, or reports exactly what is stuck.
 *
 * It never gives up quietly: an undrained queue after the network is back is
 * either a retained mutation (401/403/5xx) or a replay bug, and both are things
 * this suite exists to surface rather than wait out.
 */
export async function drainOutbox(page: Page, attempts = 8): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await replay(page);
    const remaining = await outbox(page);
    if (!remaining.length) return;
    await page.waitForTimeout(120);
  }
  const stuck = await outbox(page);
  expect(
    stuck.map((row) => `${row.kind}:${row.entityId}:attempts=${row.attempts}`),
    `the outbox did not drain after ${attempts} replay passes with the network up`,
  ).toStrictEqual([]);
}
