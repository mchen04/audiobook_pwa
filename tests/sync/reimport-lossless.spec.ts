import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  APP_ORIGIN,
  attachDriver,
  closeSql,
  commit,
  createCollection,
  drainOutbox,
  evictAudio,
  importThroughUi,
  mediaCacheEntries,
  mirror,
  openDevice,
  pull,
  resetAccount,
  sharedSession,
  sql,
  type Account,
  type StorageState,
} from "./harness/app";
import { readServerState, toDeviceState } from "./harness/state";

/**
 * Design contract section 10: re-importing an evicted book must be LOSSLESS.
 *
 * The mechanism is the fingerprint. `media_assets` is unique on
 * (owner, fingerprintKind, fingerprint), a duplicate registration answers 409
 * with `existingBookId`, and `local-import.ts` reattaches the bytes to that
 * book. So the same MP3 chosen a second time must land on the SAME book, with
 * the position, chapters, tags and collection membership it already had — not a
 * second copy of the book and not a reset to zero.
 *
 * Everything here is end to end: the file goes through the real file input, the
 * real parser, the real registration route and the real media store. The audio
 * never leaves the device on that path.
 */

const FIXTURE = path.join(process.cwd(), "tests/fixtures/Downloads/Chapterline-iPhone-Test.mp3");
const FIXTURE_TITLE = "iPhone Downloads Test";
const DEVICE = "device-reimport-00001";
const SAVED_POSITION_MS = 4_500;

let session: { account: Account; storageState: StorageState } | null = null;

test.afterAll(async () => {
  await closeSql();
});

test("re-importing an evicted book reconnects to the same book and restores everything", async ({
  browser,
}) => {
  session ??= await sharedSession(browser);
  const { account, storageState } = session;
  await resetAccount(account.userId);

  const { context, page } = await openDevice(browser, DEVICE, storageState);
  try {
    await page.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
    await attachDriver(page, account, DEVICE);

    // ---------------------------------------------------------------- import
    const bytes = readFileSync(FIXTURE);
    await importThroughUi(page, path.basename(FIXTURE), bytes);
    await expect(page.getByRole("link", { name: FIXTURE_TITLE, exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await attachDriver(page, account, DEVICE);
    expect(await pull(page)).toBe("applied");

    const before = await readServerState(account.userId);
    expect(before.booksByFingerprint.size, "the import did not create exactly one book").toBe(1);
    const [fingerprint, originalRow] = [...before.booksByFingerprint.entries()][0]!;
    const bookId = originalRow.bookId;
    const chapterCount = originalRow.chapterCount;
    expect(chapterCount, "the import stored no chapters").toBeGreaterThan(0);

    // --------------------------------------------- everything worth losing
    const collectionId = await createCollection(page, "Re-import Shelf");
    await commit(page, { kind: "rename", bookId, fields: { tags: ["keepme", "second"] } });
    await commit(page, { kind: "collection", collectionId, bookId, include: true });
    await commit(page, {
      kind: "progress",
      bookId,
      positionMs: SAVED_POSITION_MS,
      playbackRate: 1.25,
      completed: false,
      eventOccurredAt: new Date().toISOString(),
    });
    await drainOutbox(page);
    expect(await pull(page)).toBe("applied");

    const armed = await readServerState(account.userId);
    expect([...(armed.tagsByFingerprint.get(fingerprint) || [])].sort()).toStrictEqual([
      "keepme",
      "second",
    ]);
    expect([...(armed.collectionMembers.get("Re-import Shelf") || [])]).toStrictEqual([
      fingerprint,
    ]);
    expect(armed.progressByFingerprint.get(fingerprint)?.positionMs).toBe(SAVED_POSITION_MS);

    // ----------------------------------------------------------- eviction
    const removed = await evictAudio(page);
    expect(removed.removedCaches.length).toBeGreaterThan(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
    await expect(
      page.locator(".book-item", { hasText: FIXTURE_TITLE }).getByText(/re-import the MP3/),
      "the evicted book does not tell the user to re-import it, so nothing here would be " +
        "testing the recovery the product actually offers",
    ).toBeVisible({ timeout: 30_000 });

    // ---------------------------------------------------------- re-import
    // The same bytes, chosen again. `local-import.ts` fingerprints them, the
    // route answers 409 with `existingBookId`, and the media reattaches.
    await importThroughUi(page, path.basename(FIXTURE), bytes);
    await expect(
      page.locator(".book-item", { hasText: FIXTURE_TITLE }).getByText(/On this device · /),
      "the re-import did not reattach the audio to this device",
    ).toBeVisible({ timeout: 60_000 });

    await attachDriver(page, account, DEVICE);
    expect(await pull(page)).toBe("applied");
    expect(await mediaCacheEntries(page)).toBeGreaterThan(0);

    // ------------------------------------------------------------ verdict
    const after = await readServerState(account.userId);

    expect(
      after.booksByFingerprint.size,
      "the re-import created a SECOND book. `media_assets` is unique on " +
        "(owner, fingerprintKind, fingerprint) and a duplicate registration must be treated as " +
        "a merge, never a new book.",
    ).toBe(1);
    expect(
      after.booksByFingerprint.get(fingerprint)?.bookId,
      "the re-imported file landed on a different book id, so every reference to the old one " +
        "(progress, tags, collections, history) is now orphaned",
    ).toBe(bookId);
    expect(
      after.booksByFingerprint.get(fingerprint)?.chapterCount,
      "the chapter list changed across the re-import",
    ).toBe(chapterCount);
    expect(
      after.progressByFingerprint.get(fingerprint)?.positionMs,
      "the saved position was reset by the re-import",
    ).toBe(SAVED_POSITION_MS);
    expect(
      [...(after.tagsByFingerprint.get(fingerprint) || [])].sort(),
      "the tags were lost across the re-import",
    ).toStrictEqual(["keepme", "second"]);
    expect(
      [...(after.collectionMembers.get("Re-import Shelf") || [])],
      "the collection membership was lost across the re-import",
    ).toStrictEqual([fingerprint]);

    // The database itself, with no room for a second row hiding behind a join.
    const [counts] = await sql()<{ books: number; assets: number }[]>`
      SELECT
        (SELECT count(*)::int FROM books WHERE owner_id = ${account.userId}) AS books,
        (SELECT count(*)::int FROM media_assets WHERE owner_id = ${account.userId}) AS assets
    `;
    expect(counts, "a duplicate row was created somewhere").toMatchObject({ books: 1, assets: 1 });

    // And the device agrees, so the user sees one book with its place kept.
    const device = toDeviceState(await mirror(page));
    expect(device.booksByFingerprint.size).toBe(1);
    expect(device.progressByFingerprint.get(fingerprint)?.positionMs).toBe(SAVED_POSITION_MS);
    expect([...(device.tagsByFingerprint.get(fingerprint) || [])].sort()).toStrictEqual([
      "keepme",
      "second",
    ]);
    expect([...(device.collectionMembers.get("Re-import Shelf") || [])]).toStrictEqual([
      fingerprint,
    ]);
    // The download record the library reads for "is this playable here" is back.
    expect(
      (await mirror(page)).downloads.map((record) => record.bookId),
      "the re-import did not restore this device's download record",
    ).toStrictEqual([bookId]);
  } finally {
    await context.close();
  }
});
