import { expect, test, type Page } from "@playwright/test";

import {
  ACCOUNT_A,
  cutNetwork,
  ensureAccount,
  network,
  openDevice,
  restoreNetwork,
  sessionFor,
  warmUp,
  type Account,
  type Device,
  type StorageState,
} from "./harness/app";
import { SEED_BOOKS, seedLibrary, waitForSeededMirror } from "./harness/library-seed";

/**
 * Leaving a book has to land in the library — on any connection, by any route.
 *
 * Opening a book with the network gone is answered by the service worker with
 * the cached library document, and the one library UI reads the book id out of
 * the URL and plays this device's own copy. That makes the URL, not a click,
 * the thing that decides whether the player or the grid is on screen. The back
 * button changes the URL without a click; `AppShell` and `MiniPlayer` follow it
 * through `usePathname()` and always did, so a player that did not follow it
 * too would sit under a header and a mini player that had already returned to
 * library chrome — which is exactly the "it un-full-screens but never goes
 * back" report this spec exists to keep fixed.
 *
 * Both exits are covered, because they are separate mechanisms: the system back
 * button (a `popstate`) and the player's own Library button.
 */

const PHONE_VIEWPORT = { width: 393, height: 852 };
const ON_DEVICE_BOOK = SEED_BOOKS.find((book) => book.onDevice)!;

let account: Account;
let state: StorageState;
let device: Device;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  account = await ensureAccount(browser, ACCOUNT_A);
  state = await sessionFor(browser, account);
  device = await openDevice(browser, { storageState: state, deviceId: "parity-device-000000001" });
  await warmUp(device.page);
  await seedLibrary(browser, account, state, device);
  await waitForSeededMirror(device.page, device.origin);
});

test.afterAll(async () => {
  const net = await network();
  net.restore();
  await device?.context.close();
});

test.afterEach(async () => {
  const net = await network();
  if (net.isCut()) await restoreNetwork(device.page);
});

async function launchLibrary(): Promise<Page> {
  const page = await device.context.newPage();
  await page.setViewportSize(PHONE_VIEWPORT);
  await page.goto(`${device.origin}/library`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
  await page.waitForTimeout(1_200);
  return page;
}

/** Opens a book the way a user does, from the card, with no network. */
async function openBookOffline(page: Page): Promise<void> {
  await cutNetwork(page);
  await page.getByRole("link", { name: ON_DEVICE_BOOK.title, exact: true }).click();
  await expect(page.getByRole("button", { name: /Library/ })).toBeVisible({ timeout: 60_000 });
  expect(new URL(page.url()).pathname).toMatch(/^\/books\//);
}

async function expectLibraryOnScreen(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Add MP3" })).toBeVisible();
  expect(new URL(page.url()).pathname, "the player URL was left behind").not.toMatch(/^\/books\//);
}

test("the system back button leaves the offline player for the library", async () => {
  const page = await launchLibrary();
  try {
    await openBookOffline(page);
    await page.goBack();
    await expectLibraryOnScreen(page);
  } finally {
    await page.close();
  }
});

test("the player's own Library button leaves a working history behind", async () => {
  const page = await launchLibrary();
  try {
    await openBookOffline(page);
    const bookUrl = page.url();

    await page.getByRole("button", { name: /Library/ }).click();
    await expectLibraryOnScreen(page);

    // The button popped the player's entry rather than overwriting it, so the
    // book is still ahead in history and one forward returns to it. Overwriting
    // would strand the user with two library entries and no way forward.
    await page.goForward();
    expect(page.url()).toBe(bookUrl);
    await expect(page.getByRole("button", { name: /Library/ })).toBeVisible({ timeout: 30_000 });
  } finally {
    await page.close();
  }
});
