import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ACCOUNT_A,
  ACCOUNT_B,
  apiCall,
  endSessionWithoutPurge,
  ensureAccount,
  importThroughUi,
  network,
  openDevice,
  resetAccount,
  signInThroughUi,
  signOutThroughUi,
  sql,
  warmUp,
  type Account,
  type Device,
} from "./harness/app";
import { bookBuffer, SEED_BOOKS } from "./harness/library-seed";
import {
  accountBearingPageEntries,
  mediaEntries,
  readDeviceStorage,
  readLibrary,
  residueOf,
  type DeviceStorage,
} from "./harness/snapshot";

/**
 * The privacy gate — `docs/local-first.md` section 11.
 *
 * "A cached page, mirrored row, or downloaded file from one account must never
 * be readable by another." This suite proves that by reading the DEVICE, not
 * the screen: every object store of both IndexedDB databases, every Cache
 * Storage entry and every localStorage key, enumerated with plain platform APIs
 * so a store the purge forgets is still counted.
 *
 * The classic false pass here is a purge test that passes because the mirror
 * was empty to begin with. Every test below therefore seeds account A until
 * fourteen named stores hold its rows, ASSERTS that they do, and only then
 * switches accounts. Prove non-empty, then prove empty.
 */

const FIXTURE_DIR = path.join(process.cwd(), "tests/fixtures");
const TRANSCRIPT_FIXTURE = path.join(FIXTURE_DIR, "transcripts/tiny-book.mp3");

const KEPT_BOOK = SEED_BOOKS[0]!;
const DROPPED_BOOK = SEED_BOOKS[1]!;
const TRANSCRIPT_BOOK_TITLE = "Tiny Fixture Book";

/**
 * Every store that must hold account A's data before the switch, and must hold
 * none of it after.
 *
 * The list is written out rather than derived, because deriving it from
 * whatever happens to be populated is how a purge test comes to assert nothing:
 * a store that silently stopped being seeded would simply drop out of both
 * halves and never be checked again.
 */
const STORES_THAT_MUST_HOLD_A = [
  "chapterline-offline-v1/books",
  "chapterline-offline-v1/chapters",
  "chapterline-offline-v1/playbackStates",
  "chapterline-offline-v1/tags",
  "chapterline-offline-v1/bookTags",
  "chapterline-offline-v1/collections",
  "chapterline-offline-v1/collectionBooks",
  "chapterline-offline-v1/preferences",
  "chapterline-offline-v1/listeningSessions",
  "chapterline-offline-v1/syncMeta",
  "chapterline-offline-v1/downloads",
  "chapterline-offline-v1/transcripts",
  "chapterline-offline-v1/deletions",
  "chapterline-offline-v1/cacheEntries",
  "chapterline-sync-v1/mutations",
  "hark-playback-history-v1/actions",
] as const;

let accountA: Account;
let accountB: Account;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  accountA = await ensureAccount(browser, ACCOUNT_A);
  accountB = await ensureAccount(browser, ACCOUNT_B);
});

test.afterAll(async () => {
  const net = await network();
  net.restore();
});

/**
 * Fills every store in `STORES_THAT_MUST_HOLD_A` through the shipping paths:
 * two imports (audio in Cache Storage, chapter transcripts in `transcripts`), a
 * third import that is then removed through the UI so the deletion journal has
 * a row, tag / collection / preference / session / progress mutations, a pull
 * that mirrors all of it, and one mutation left queued in the outbox.
 */
async function seedAccountA(page: Page, origin: string, account: Account): Promise<string> {
  await importThroughUi(page, "purge-kept.mp3", bookBuffer(KEPT_BOOK, 0));
  await expect(page.getByRole("link", { name: KEPT_BOOK.title, exact: true })).toBeVisible({
    timeout: 60_000,
  });

  await importThroughUi(page, "purge-transcript.mp3", readFileSync(TRANSCRIPT_FIXTURE));
  await expect(page.getByRole("link", { name: TRANSCRIPT_BOOK_TITLE, exact: true })).toBeVisible({
    timeout: 60_000,
  });

  // A third book, imported and then un-downloaded through the real control, so
  // the deletion journal carries a row naming this account and its book.
  await importThroughUi(page, "purge-dropped.mp3", bookBuffer(DROPPED_BOOK, 1));
  await expect(page.getByRole("link", { name: DROPPED_BOOK.title, exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await page
    .locator("article.book-item", { hasText: DROPPED_BOOK.title })
    .getByRole("button", { name: `Remove download of ${DROPPED_BOOK.title}` })
    .click();
  await expect(
    page
      .locator("article.book-item", { hasText: DROPPED_BOOK.title })
      .getByText("Not on this device", { exact: false }),
  ).toBeVisible({ timeout: 30_000 });

  const listed = await apiCall(page, "GET", "/api/books?status=all");
  expect(listed.status).toBe(200);
  const books = (listed.body as { books: Array<{ id: string; title: string }> }).books;
  const keptId = books.find((book) => book.title === KEPT_BOOK.title)?.id;
  expect(keptId, "the seeded book was never registered").toBeTruthy();

  expect((await apiCall(page, "PATCH", `/api/books/${keptId}`, { tags: ["private"] })).status).toBe(
    200,
  );
  expect((await apiCall(page, "PATCH", "/api/preferences", { skipBackMs: 15_000 })).status).toBe(
    200,
  );
  const collection = await apiCall(page, "POST", "/api/collections", { name: "A private shelf" });
  expect(collection.status).toBe(201);
  const collectionId = (collection.body as { collection: { id: string } }).collection.id;
  expect(
    (
      await apiCall(page, "PATCH", `/api/collections/${collectionId}`, {
        bookId: keptId,
        include: true,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await apiCall(page, "PATCH", `/api/books/${keptId}/progress`, {
        deviceId: "purge-device-00000001",
        deviceSequence: 1,
        positionMs: 5_000,
        playbackRate: 1,
        completed: false,
        eventOccurredAt: new Date().toISOString(),
      })
    ).status,
  ).toBeLessThan(300);
  expect(
    (
      await apiCall(page, "POST", `/api/books/${keptId}/sessions`, {
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        endedAt: new Date().toISOString(),
        startPositionMs: 0,
        endPositionMs: 5_000,
      })
    ).status,
  ).toBeLessThan(300);

  // Playback history: a play and a seek in the real player, which is the only
  // thing that writes `hark-playback-history-v1`. That database is a separate
  // origin-level store, opened by a lazily-imported module, and it records what
  // this account listened to and when — exactly the kind of thing an account
  // switch must not leave behind.
  await page.goto(`${origin}/books/${keptId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: KEPT_BOOK.title })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("slider", { name: "Audiobook position" }).fill("3000");
  await page.getByRole("button", { name: "Pause" }).click();

  // A pull, so everything above is mirrored onto this device.
  await page.goto(`${origin}/library`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
  await page.waitForTimeout(2_000);

  // One mutation left in the outbox, journaled by the SHIPPING mutation API.
  // Nothing on this page replays it: only the player does that.
  const queued = await page.evaluate(
    async ([userId, bookId]) => {
      window.__harkSync.configure(userId as string, "purge-device-00000001");
      return window.__harkSync.commit({
        kind: "progress",
        bookId: bookId as string,
        positionMs: 7_000,
        playbackRate: 1,
        completed: false,
        eventOccurredAt: new Date().toISOString(),
      });
    },
    [account.userId, keptId!] as const,
  );
  expect(queued.mutationId, "no mutation was journaled into the outbox").toBeTruthy();
  return keptId!;
}

/** Refuses to continue unless the device really is holding account A's life. */
function expectAccountAIsOnTheDevice(storage: DeviceStorage, account: Account): void {
  const empty = STORES_THAT_MUST_HOLD_A.filter(
    (store) => (storage.stores[store]?.ownedByTarget ?? 0) === 0,
  );
  expect(
    empty,
    "these stores hold nothing for account A, so a purge assertion against them would pass " +
      "whether or not the purge ran. The seed is broken, not the product.",
  ).toStrictEqual([]);
  expect(mediaEntries(storage).length, "no audio was stored for account A").toBeGreaterThan(0);
  expect(storage.activeUser, "the device is not signed into account A").toBe(account.userId);
  expect(
    storage.localStorageMentioningTarget.length,
    "no localStorage key names account A",
  ).toBeGreaterThan(0);
}

/**
 * The gate itself. Polled, because the sweep is fired from `authClient`'s
 * `onSuccess` hook and awaited nowhere the test can see — but the bar never
 * moves: every store must reach zero.
 */
async function expectNothingOfAccountARemains(
  page: Page,
  account: Account,
  /** The account now signed in, or `null` when nobody is — the sign-out case. */
  incoming: Account | null,
): Promise<DeviceStorage> {
  await expect
    .poll(async () => residueOf(await readDeviceStorage(page, account.userId)), {
      timeout: 45_000,
      message:
        "account A's data is still on this device after another account signed in. " +
        "docs/local-first.md section 11: a mirrored row, cached page or downloaded file from " +
        "one account must never be readable by another.",
    })
    .toStrictEqual([]);

  const after = await readDeviceStorage(page, account.userId);
  expect(
    mediaEntries(after),
    "account A's audio is still in Cache Storage after the switch",
  ).toStrictEqual([]);
  expect(
    accountBearingPageEntries(after),
    "an account-bearing page is still cached after the switch; only the user-agnostic shell " +
      "of section 8 may survive one",
  ).toStrictEqual([]);
  expect(
    after.localStorageMentioningTarget,
    "a localStorage key still names account A after the switch",
  ).toStrictEqual([]);
  // Per-book replay high-water marks are DELIBERATELY kept
  // (`src/lib/offline-sync.ts`: "losing them loses writes"). They are keyed by
  // bookId and carry no userId, so `residueOf` cannot see them — which is
  // exactly why they are named here rather than left unexamined. What must
  // still hold is that nothing in them identifies the departed account.
  for (const store of ["chapterline-sync-v1/sequences", "hark-playback-history-v1/sequences"]) {
    const dump = after.stores[store];
    console.log(`[parity] ${store} after the switch: ${dump?.count ?? 0} row(s) retained`);
    expect(
      dump?.mentionsTarget ?? 0,
      `${store} still holds a record naming account A after the switch`,
    ).toBe(0);
  }
  expect(
    after.activeUser,
    incoming
      ? "the device did not move to the incoming account"
      : "the device still says it belongs to the account that signed out",
  ).toBe(incoming ? incoming.userId : null);
  return after;
}

/** And the screen agrees: nothing of A's library is on it. */
async function expectLibraryShowsNothingOfA(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/library`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
  const snapshot = await readLibrary(page);
  // "empty" rather than merely "no cards": the readiness marker is only allowed
  // to say that when the GENUINE empty state is on screen, so this cannot be
  // satisfied by a skeleton or a still-syncing notice.
  expect(
    snapshot.launchReady,
    "the incoming account did not reach the genuine empty-library state",
  ).toBe("empty");
  expect(
    snapshot.books.map((book) => book.title),
    "the incoming account can still see the previous one's books",
  ).toStrictEqual([]);
}

/**
 * Signs out and refuses to let the product's own warning be mistaken for a
 * harness timeout.
 *
 * `AccountMenu` deliberately stops on `/settings` and shows an alert when a
 * queued write could not be delivered before the sweep destroyed it, rather
 * than navigating away from the news. `signOutThroughUi` is waiting for
 * `/login`, so that shows up as an opaque 60s timeout unless the alert is read
 * back. It is a genuine failure either way — a lost write — but it must read as
 * one.
 */
async function signOutAndReportLostWrites(page: Page): Promise<void> {
  await signOutThroughUi(page).catch(async (error: unknown) => {
    const warning = await page
      .getByRole("alert")
      .first()
      .innerText()
      .catch(() => "");
    if (!warning) throw error;
    throw new Error(
      `sign-out stopped to report writes it could not deliver: ${warning}. ` +
        "docs/local-first.md section 5: a queued mutation is a user write that exists nowhere " +
        "else, and signing out is not allowed to be what destroys it.",
    );
  });
}

// ---------------------------------------------------------------------------

/**
 * The case the rest of this file never covered: SIGN OUT, then look at the
 * device. Nobody signs back in.
 *
 * Every other test here signs account B in immediately afterwards, where
 * `purgeOnSignIn` cleans up whatever the sign-out left — so a sign-out purge
 * that did nothing at all still passed them. The device is read here in exactly
 * the state a user leaves it in when they hand the phone over, or when the next
 * person to open the app is not a person who signs in.
 */
test("signing out leaves nothing of the account on the device, with nobody signed in", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  await resetAccount(accountA.userId);
  const device: Device = await openDevice(browser, {
    withDriver: true,
    deviceId: "purge-device-00000001",
  });
  try {
    await signInThroughUi(device.page, accountA);
    await warmUp(device.page);
    const keptId = await seedAccountA(device.page, device.origin, accountA);

    // One more unsent write, chosen because its delivery is visible in the
    // server's own row rather than only in the absence of a local one: sign-out
    // clears the outbox, so "the queue is empty afterwards" is equally true of
    // a write that landed and one that was thrown away.
    const renamed = `Renamed before signing out ${Date.now()}`;
    await device.page.evaluate(
      async ([userId, bookId, title]) => {
        window.__harkSync.configure(userId as string, "purge-device-00000001");
        await window.__harkSync.commit({
          kind: "rename",
          bookId: bookId as string,
          fields: { title: title as string },
        });
      },
      [accountA.userId, keptId, renamed] as const,
    );

    const before = await readDeviceStorage(device.page, accountA.userId);
    expectAccountAIsOnTheDevice(before, accountA);

    await signOutAndReportLostWrites(device.page);

    // NOBODY signs in. This is the whole point of the test.
    await expectNothingOfAccountARemains(device.page, accountA, null);

    const [book] = await sql()<{ title: string }[]>`
      SELECT title FROM books WHERE id = ${keptId}::uuid
    `;
    expect(
      book?.title,
      "the edit queued before signing out never reached the server, and the sign-out purge " +
        "deleted the only copy of it. docs/local-first.md section 5.",
    ).toBe(renamed);
  } finally {
    await device.context.close();
  }
});

test("signing out and signing another account in leaves nothing of the first readable", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  await resetAccount(accountA.userId);
  await resetAccount(accountB.userId);
  const device: Device = await openDevice(browser, {
    withDriver: true,
    deviceId: "purge-device-00000001",
  });
  try {
    await signInThroughUi(device.page, accountA);
    await warmUp(device.page);
    await seedAccountA(device.page, device.origin, accountA);

    const before = await readDeviceStorage(device.page, accountA.userId);
    expectAccountAIsOnTheDevice(before, accountA);

    await signOutAndReportLostWrites(device.page);
    await signInThroughUi(device.page, accountB);

    await expectNothingOfAccountARemains(device.page, accountA, accountB);
    await expectLibraryShowsNothingOfA(device.page, device.origin);
  } finally {
    await device.context.close();
  }
});

test("a sign-in finishes a purge a crash interrupted", async ({ browser }) => {
  test.setTimeout(300_000);
  await resetAccount(accountA.userId);
  await resetAccount(accountB.userId);
  const device: Device = await openDevice(browser, {
    withDriver: true,
    deviceId: "purge-device-00000001",
  });
  try {
    await signInThroughUi(device.page, accountA);
    await warmUp(device.page);
    await seedAccountA(device.page, device.origin, accountA);

    const before = await readDeviceStorage(device.page, accountA.userId);
    expectAccountAIsOnTheDevice(before, accountA);

    // The crash section 11 says the sign-in purge exists to cover: the session
    // ends server-side without `authClient`'s hook ever running, so nothing is
    // swept on the way out and the incoming account inherits everything.
    await endSessionWithoutPurge(device.page);
    const stranded = await readDeviceStorage(device.page, accountA.userId);
    expect(
      residueOf(stranded).length,
      "the interrupted sign-out cleaned up by itself, so the sign-in purge below would have " +
        "nothing to do and this test would prove nothing about it",
    ).toBeGreaterThan(0);
    expectAccountAIsOnTheDevice(stranded, accountA);

    await signInThroughUi(device.page, accountB);

    await expectNothingOfAccountARemains(device.page, accountA, accountB);
    await expectLibraryShowsNothingOfA(device.page, device.origin);
  } finally {
    await device.context.close();
  }
});
