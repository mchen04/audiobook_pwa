import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  APP_ORIGIN,
  attachDriver,
  closeSql,
  commit,
  drainOutbox,
  evictAudio,
  evictMirror,
  importThroughUi,
  mediaCacheEntries,
  mirror,
  openDevice,
  pull,
  resetAccount,
  sharedSession,
  type Account,
  type StorageState,
} from "./harness/app";
import { readBookIds } from "./harness/state";

/**
 * Design contract section 10 — two different losses, two different recoveries.
 *
 * - The MIRROR is metadata that Postgres still holds, so losing it is
 *   recoverable: the app must notice, re-pull, and carry on.
 * - The AUDIO exists on this device and nowhere else in the world. Losing it is
 *   not recoverable from anything. The book must stay visible with its metadata
 *   intact, must never look playable, and must say plainly that the file has to
 *   be re-imported. It must never be silently dropped.
 *
 * Both cases start from a real import through the shipping path, so the bytes
 * really are in Cache Storage before they are taken away. Nothing in this file
 * moves audio anywhere; eviction only deletes.
 */

const FIXTURE = path.join(process.cwd(), "tests/fixtures/Downloads/Chapterline-iPhone-Test.mp3");
const FIXTURE_TITLE = "iPhone Downloads Test";
const DEVICE = "device-eviction-000001";

let session: { account: Account; storageState: StorageState } | null = null;

test.afterAll(async () => {
  await closeSql();
});

function bookCard(page: Page, title: string = FIXTURE_TITLE) {
  return page.locator(".book-item", { hasText: title });
}

async function importedDevice(browser: Parameters<typeof openDevice>[0]) {
  session ??= await sharedSession(browser);
  const { account, storageState } = session;
  await resetAccount(account.userId);

  const { context, page } = await openDevice(browser, DEVICE, storageState);
  await page.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
  await attachDriver(page, account, DEVICE);

  await importThroughUi(page, path.basename(FIXTURE), readFileSync(FIXTURE));
  await expect(page.getByRole("link", { name: FIXTURE_TITLE, exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await attachDriver(page, account, DEVICE);
  expect(await pull(page)).toBe("applied");

  // The import really did put bytes on this device, and the server really does
  // hold the metadata. Both are preconditions for the losses below to mean
  // anything.
  expect(
    await mediaCacheEntries(page),
    "the import left nothing in Cache Storage, so there is no audio to evict",
  ).toBeGreaterThan(0);
  const snapshot = await mirror(page);
  expect(snapshot.downloads, "the import left no download record").toHaveLength(1);
  const bookId = snapshot.downloads[0]!.bookId;
  expect(
    (await readBookIds(account.userId)).size,
    "the import did not register with the server",
  ).toBe(1);

  return { context, page, account, bookId };
}

test("mirror evicted: the library metadata re-pulls from Postgres and comes back", async ({
  browser,
}) => {
  const { context, page, account, bookId } = await importedDevice(browser);
  try {
    // A fact that lives ONLY in the mirror. The download record carries no tags
    // (`use-library-books.ts#asLibraryBook` sets `tags: []`), so a tag chip on
    // screen after the wipe can only have come back from Postgres — which is
    // what makes this a recovery test rather than a "the download row survived"
    // test.
    await commit(page, {
      kind: "rename",
      bookId,
      fields: { title: "Renamed Before Eviction", tags: ["evidence"] },
    });
    await drainOutbox(page);
    expect(await pull(page)).toBe("applied");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("link", { name: "Renamed Before Eviction" })).toBeVisible({
      timeout: 30_000,
    });

    await attachDriver(page, account, DEVICE);
    await evictMirror(page);
    const wiped = await mirror(page);
    expect(wiped.books, "evictMirror left books behind").toStrictEqual([]);
    expect(wiped.tags).toStrictEqual([]);
    expect(wiped.syncMeta, "evictMirror left the pull cursor behind").toBeUndefined();
    expect(
      wiped.downloads,
      "evictMirror removed the download record; eviction of the mirror must not touch the audio",
    ).toHaveLength(1);

    // No driver call: the app's own launch path has to notice the empty mirror
    // and re-pull (`use-library-books.ts` treats a missing cursor as a cold
    // start and fills the mirror before showing an empty library).
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("link", { name: "Renamed Before Eviction" }),
      "the library did not come back after the mirror was evicted",
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator(".book-tags", { hasText: "evidence" }),
      "the book came back but without its tags, so the metadata did not re-pull from Postgres " +
        "— this is the download record being shown, not a recovered mirror",
    ).toBeVisible({ timeout: 30_000 });

    await attachDriver(page, account, DEVICE);
    const recovered = await mirror(page);
    expect(recovered.books.map((book) => book.title)).toStrictEqual(["Renamed Before Eviction"]);
    expect(recovered.syncMeta?.cursor, "the pull cursor was not re-established").toBeTruthy();
    expect(recovered.chapters.length, "the book's chapters did not come back").toBeGreaterThan(0);
    // The audio was never involved, so the book is still playable here.
    await expect(
      bookCard(page, "Renamed Before Eviction").getByText(/On this device · /),
      "the audio was never evicted here, so the book must still be playable on this device",
    ).toBeVisible();
    expect(await mediaCacheEntries(page)).toBeGreaterThan(0);
    void account;
  } finally {
    await context.close();
  }
});

test("audio evicted: the book stays visible, never looks playable, and says to re-import", async ({
  browser,
}) => {
  const { context, page, account } = await importedDevice(browser);
  try {
    const removed = await evictAudio(page);
    expect(
      removed.removedCaches.length,
      "no media cache was found to evict, so nothing was actually taken away",
    ).toBeGreaterThan(0);
    expect(await mediaCacheEntries(page)).toBe(0);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });

    // 1. Never silently dropped.
    await expect(
      page.getByRole("link", { name: FIXTURE_TITLE, exact: true }),
      "the book disappeared from the library when its audio was evicted. The metadata still " +
        "exists in Postgres and the user must still be able to see, search and organise it.",
    ).toBeVisible({ timeout: 30_000 });

    // 2. Metadata intact.
    await attachDriver(page, account, DEVICE);
    const snapshot = await mirror(page);
    expect(snapshot.books.map((book) => book.title)).toStrictEqual([FIXTURE_TITLE]);
    expect(snapshot.chapters.length, "the chapters were lost with the audio").toBeGreaterThan(0);

    // 3. Honest about what happened, in the words the product uses.
    await expect(
      bookCard(page).getByText("Not on this device — re-import the MP3 to listen"),
      "the library does not tell the user the file has to be re-imported",
    ).toBeVisible();

    // 4. Never looks playable, and offers no control that implies the audio is
    //    still here.
    await expect(
      bookCard(page).getByRole("button", { name: /Remove download/ }),
      "the card still offers to remove a download that no longer exists",
    ).toHaveCount(0);
    await expect(bookCard(page).getByText(/On this device · /)).toHaveCount(0);

    // 5. The stale download record is reconciled away rather than left to make
    //    the book look playable on the next launch.
    await expect
      .poll(async () => (await mirror(page)).downloads.length, {
        message:
          "the download record survived its audio, so the library still believes the bytes " +
          "are on this device",
        timeout: 15_000,
      })
      .toBe(0);

    // 6. The "On this device" facet must now be honest too.
    await page.getByRole("button", { name: "On this device" }).click();
    await expect(page.getByRole("heading", { name: "Nothing downloaded yet" })).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await context.close();
  }
});
