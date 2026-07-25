import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  APP_ORIGIN,
  attachDriver,
  closeSql,
  drainOutbox,
  goOffline,
  goOnline,
  importThroughUi,
  mirror,
  openDevice,
  outbox,
  pull,
  resetAccount,
  sharedSession,
} from "./harness/app";
import { readServerState } from "./harness/state";

/**
 * The seam test: an edit a person actually makes, with the network gone.
 *
 * Every other spec in this directory drives `window.__harkSync`, which forwards
 * into the production outbox. That proves the ENGINE. It cannot prove the
 * PRODUCT, because it bypasses the one thing most likely to be wrong — whether
 * the shipping UI calls the engine at all. This project has already been bitten
 * by exactly that: the outbox was built, tested and green while every button in
 * the app still wrote straight to the network with `fetch`, so a fuzz reporting
 * zero lost writes was describing a module nobody's tap could reach.
 *
 * So nothing below touches the driver until the assertions are over. The title
 * is typed into the real input, the real "Save changes" button is clicked, the
 * real "Archive" button is clicked, and the network is genuinely off at the
 * stack while it happens. The driver is attached only afterwards, to read the
 * outbox and the mirror.
 *
 * The proof runs in three parts, and all three matter:
 *   1. the edit is journalled and visibly acknowledged while offline;
 *   2. the server has NOT heard it yet — otherwise "offline" was a fiction;
 *   3. after reconnect it arrives, without anyone touching a retry button.
 */

const FIXTURE = path.join(process.cwd(), "tests/fixtures/Downloads/Chapterline-iPhone-Test.mp3");
const FIXTURE_TITLE = "iPhone Downloads Test";
const DEVICE = "device-real-ui-0001";

const EDITED_TITLE = "Edited On A Plane";
const EDITED_TAG = "queued-by-hand";

test.afterAll(async () => {
  await closeSql();
});

test("an edit made through the real UI with the network gone is kept and lands on reconnect", async ({
  browser,
}) => {
  const { account, storageState } = await sharedSession(browser);
  await resetAccount(account.userId);

  const { context, page } = await openDevice(browser, DEVICE, storageState);
  try {
    await page.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });

    // ------------------------------------------------------------- a real book
    await attachDriver(page, account, DEVICE);
    const bytes = readFileSync(FIXTURE);
    await importThroughUi(page, path.basename(FIXTURE), bytes);
    const card = page.getByRole("link", { name: FIXTURE_TITLE, exact: true });
    await expect(card).toBeVisible({ timeout: 60_000 });
    await attachDriver(page, account, DEVICE);
    expect(await pull(page)).toBe("applied");

    const seeded = await readServerState(account.userId);
    expect(seeded.booksByFingerprint.size, "the import did not produce exactly one book").toBe(1);
    const [fingerprint] = [...seeded.booksByFingerprint.keys()];
    if (!fingerprint) throw new Error("the import registered no media asset to edit");
    const bookId = seeded.booksByFingerprint.get(fingerprint)!.bookId;

    // Open the player and the details dialog while the network is still up.
    // The dialog is a dynamic import, so its chunk has to be fetched; doing that
    // offline would be testing the bundler, not the write path. A user who has
    // opened a book once before losing signal is in exactly this state.
    await card.click();
    await page.waitForURL(/\/books\//, { timeout: 30_000 });
    await page.getByRole("button", { name: "Details" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Book details" })).toBeVisible({
      timeout: 30_000,
    });

    // ------------------------------------------------------------ network gone
    await goOffline(context, page);

    // ------------------------------------------- the edit, through the real UI
    await dialog.getByLabel("Title").fill(EDITED_TITLE);
    await dialog.getByLabel("Tags (comma separated)").fill(EDITED_TAG);
    await dialog.getByRole("button", { name: "Save changes" }).click();

    // The user has to be TOLD it is kept. An edit that silently vanished and an
    // edit that was silently queued look identical on screen, and only one of
    // them is this product.
    const notice = dialog.getByRole("status");
    await expect(notice).toContainText("Saved to this device.", { timeout: 30_000 });
    await expect(notice).toHaveAttribute("data-queued", "true");
    await expect(
      dialog.getByText(/could not/i),
      "the offline edit surfaced an error, so the UI is still treating the network as required",
    ).toHaveCount(0);

    await dialog.getByRole("button", { name: "Archive" }).click();
    await expect(notice).toContainText("Archived.", { timeout: 30_000 });

    // ------------------------------------------------ 1. it is on this device
    await attachDriver(page, account, DEVICE);
    const queued = await outbox(page);
    const kinds = queued.map((row) => row.kind).sort();
    expect(
      kinds,
      `nothing reached the outbox from the real UI. Queued rows: ${JSON.stringify(queued)}`,
    ).toEqual(expect.arrayContaining(["archive", "metadata", "tag"]));

    const local = await mirror(page);
    expect(
      local.books.find((book) => book.bookId === bookId)?.title,
      "the mirror still holds the old title, so the library would show the edit reverting",
    ).toBe(EDITED_TITLE);

    // -------------------------------------------- 2. the server has not heard
    const duringOutage = await readServerState(account.userId);
    expect(
      duringOutage.booksByFingerprint.get(fingerprint)?.title,
      "the server already has the edit, so the network was never actually gone and every " +
        "'queued while offline' claim above is meaningless",
    ).toBe(FIXTURE_TITLE);

    // ------------------------------------------------ 3. reconnect delivers it
    await goOnline(context, page);
    await drainOutbox(page);

    const after = await readServerState(account.userId);
    const server = after.booksByFingerprint.get(fingerprint);
    expect(server?.title, "the queued rename never reached the server").toBe(EDITED_TITLE);
    expect(server?.archived, "the queued archive never reached the server").toBe(true);
    expect(
      [...(after.tagsByFingerprint.get(fingerprint) ?? [])].sort(),
      "the queued tag never reached the server",
    ).toEqual([EDITED_TAG]);

    expect(
      (await outbox(page)).length,
      "the outbox still holds rows the server has already accepted",
    ).toBe(0);
  } finally {
    await context.close();
  }
});
