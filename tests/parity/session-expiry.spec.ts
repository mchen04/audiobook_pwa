import { expect, test } from "@playwright/test";

import {
  ACCOUNT_A,
  ensureAccount,
  importThroughUi,
  network,
  openDevice,
  resetAccount,
  revokeSessions,
  signInThroughUi,
  warmUp,
  type Account,
  type Device,
} from "./harness/app";
import { bookBuffer, SEED_BOOKS } from "./harness/library-seed";
import { mediaEntries, readDeviceStorage } from "./harness/snapshot";

/**
 * `docs/local-first.md` section 8, the half that is easy to get catastrophically
 * wrong.
 *
 * A revoked or expired session must send the user to `/login` — nobody may be
 * left sitting on a cached library they are no longer entitled to. And it must
 * do that WITHOUT purging: the purge path deletes downloads and their media,
 * and per section 2 those MP3s exist nowhere else in the world. A session
 * timing out overnight is routine; it must not cost the user every audiobook on
 * the device.
 *
 * So this asserts both halves. Either one alone would let the other regress.
 */

const BOOK = SEED_BOOKS[0]!;

let account: Account;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  account = await ensureAccount(browser, ACCOUNT_A);
});

test.afterAll(async () => {
  const net = await network();
  net.restore();
});

test("a revoked session lands on /login and destroys nothing this device holds", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  await resetAccount(account.userId);
  const device: Device = await openDevice(browser, { deviceId: "expiry-device-00000001" });
  try {
    await signInThroughUi(device.page, account);
    await warmUp(device.page);
    await importThroughUi(device.page, "expiry.mp3", bookBuffer(BOOK, 0));
    await expect(device.page.getByRole("link", { name: BOOK.title, exact: true })).toBeVisible({
      timeout: 60_000,
    });
    // Let the pull that follows the import land, so the mirror is populated too.
    await device.page.reload({ waitUntil: "domcontentloaded" });
    await device.page.waitForSelector("[data-launch-ready]", { state: "attached" });
    await device.page.waitForTimeout(2_000);

    const before = await readDeviceStorage(device.page, account.userId);
    const downloadsBefore = before.stores["chapterline-offline-v1/downloads"]?.ownedByTarget ?? 0;
    const mirrorBefore = before.stores["chapterline-offline-v1/books"]?.ownedByTarget ?? 0;
    const mediaBefore = mediaEntries(before);
    expect(downloadsBefore, "no download to protect, so this test would prove nothing").toBe(1);
    expect(mediaBefore.length, "no audio to protect on this device").toBeGreaterThan(0);
    expect(mirrorBefore, "the mirror never filled, so its survival is untestable").toBeGreaterThan(
      0,
    );

    // Revoked server-side, the way an administrator or an expiry does it. The
    // device is told nothing.
    const revoked = await revokeSessions(account.userId);
    expect(revoked, "no session row was deleted, so nothing was actually revoked").toBeGreaterThan(
      0,
    );

    // A launch: a brand-new document in the same warm profile, at the URL the
    // Home Screen icon uses.
    const launched = await device.context.newPage();
    await launched.goto(`${device.origin}/library?source=pwa`, { waitUntil: "domcontentloaded" });
    await expect
      .poll(() => launched.url().replace(device.origin, "").split("?")[0], {
        timeout: 60_000,
        message:
          "a launch with a revoked session left the user on a cached library instead of " +
          "sending them to /login",
      })
      .toBe("/login");

    // And nothing was destroyed on the way. The audio in particular exists
    // nowhere else: the server has never held the bytes.
    const after = await readDeviceStorage(launched, account.userId);
    expect(
      after.stores["chapterline-offline-v1/downloads"]?.ownedByTarget ?? 0,
      "an expired session deleted this device's downloads. Section 8: expiry is not a trust " +
        "boundary, a new sign-in is — and those MP3s exist nowhere else.",
    ).toBe(downloadsBefore);
    expect(
      mediaEntries(after),
      "an expired session deleted this device's audio from Cache Storage",
    ).toStrictEqual(mediaBefore);
    expect(
      after.stores["chapterline-offline-v1/books"]?.ownedByTarget ?? 0,
      "an expired session purged the mirror",
    ).toBe(mirrorBefore);
    expect(
      after.stores["chapterline-offline-v1/transcripts"]?.count ?? 0,
      "an expired session dropped stored transcripts",
    ).toBe(before.stores["chapterline-offline-v1/transcripts"]?.count ?? 0);
  } finally {
    await device.context.close();
  }
});
