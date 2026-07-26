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
import {
  CONTINUE_BOOK,
  IMPORT_ORDER,
  SEED_BOOKS,
  VISIBLE_SEED_BOOKS,
  seedLibrary,
  waitForSeededMirror,
} from "./harness/library-seed";
import { readLibrary, titlesOf, type LibrarySnapshot } from "./harness/snapshot";

/**
 * `docs/local-first.md` sections 8 and 9, as gates.
 *
 * One library UI, at one URL, behaving identically with the network on and with
 * it gone — because nothing on the read path asks whether the network is there.
 *
 * The comparison is structural and total: URL, heading, every control and its
 * state, and the full ordered list of rendered book cards with each card's
 * title, author, tags, device line, badges, play affordance and progress text.
 * A count would agree while the offline library showed different books; this
 * cannot. And every offline phase is proved twice — a control request that
 * cannot connect, and zero requests reaching the app server.
 */

/**
 * The phone the project emulates is 393px wide and `.view-switch` is
 * `display: none` below 560px, so the grid/list toggle is genuinely
 * unreachable there — for the user as much as for the test. Skipping it would
 * leave a shipped control unverified, so the control exercises run at 760x900,
 * a width where it is really on screen, and the phone width is still covered by
 * the parity comparison below (which asserts the toggle is equally hidden with
 * the network on and off).
 */
const WIDE_VIEWPORT = { width: 760, height: 900 };
const PHONE_VIEWPORT = { width: 393, height: 852 };

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

/** A launch: a brand-new document in the same warm profile. */
async function launch(url: string, viewport = PHONE_VIEWPORT): Promise<Page> {
  const page = await device.context.newPage();
  await page.setViewportSize(viewport);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
  // Revalidation runs after paint and patches the rendered list in place. Both
  // sides of every comparison below are read after it has had its chance, so
  // the online side is never caught mid-patch — and the offline side pays the
  // same wait, so the two are read at the same point in the lifecycle.
  await page.waitForTimeout(1_200);
  return page;
}

/** Fails loudly if anything reached the app server while it was meant to be gone. */
async function expectNothingReachedTheServer(label: string): Promise<void> {
  const net = await network();
  const hits = net.hits();
  expect(
    hits.map((hit) => `${hit.kind} ${hit.method} ${hit.path}`),
    `${label}: requests reached the app server during a phase that is meant to have no network ` +
      "at all, so nothing observed in it can be attributed to local data",
  ).toStrictEqual([]);
  expect(
    net.blockedCount(),
    `${label}: the network was cut but nothing even tried to use it, so the cut proves nothing`,
  ).toBeGreaterThan(0);
}

/**
 * The library must be worth comparing. Two empty screens match perfectly, and
 * so do two screens that lost the same book, so the online side is pinned to
 * the seed before it is ever used as the reference.
 */
function expectSeededLibrary(snapshot: LibrarySnapshot): void {
  expect(snapshot.launchReady, "the library never reported real content on screen").toBe("books");
  expect(titlesOf(snapshot).sort()).toStrictEqual(
    VISIBLE_SEED_BOOKS.map((book) => book.title).sort(),
  );
  expect(
    snapshot.books.filter((book) => book.onDevice).length,
    "the comparison needs books whose audio IS on this device",
  ).toBe(VISIBLE_SEED_BOOKS.filter((book) => book.onDevice).length);
  expect(
    snapshot.books.filter((book) => !book.onDevice).length,
    "the comparison needs books whose audio is NOT on this device",
  ).toBe(VISIBLE_SEED_BOOKS.filter((book) => !book.onDevice).length);
  expect(snapshot.tagChips.map((chip) => chip.label).sort()).toStrictEqual(["#epic", "#fiction"]);
  expect(snapshot.statusChips.map((chip) => chip.label)).toStrictEqual([
    "All",
    "In progress",
    "Not started",
    "Finished",
    "Archived",
  ]);
  expect(snapshot.continueCard?.title).toBe(CONTINUE_BOOK.title);
  expect(snapshot.search.present).toBe(true);
  expect(snapshot.sort.options).toStrictEqual([
    "activity=Recent activity",
    "added=Recently added",
    "title=Title A–Z",
    "author=Author A–Z",
  ]);
  expect(snapshot.viewSwitch.buttons).toStrictEqual(["Grid view", "List view"]);
  expect(snapshot.headerDownloadsHref).toBe("/library?device=1");
}

// ---------------------------------------------------------------------------
// 1. Same route, same controls, same books
// ---------------------------------------------------------------------------

for (const [label, url, viewport] of [
  ["/library on the phone", "/library", PHONE_VIEWPORT],
  ["/library?device=1 on the phone", "/library?device=1", PHONE_VIEWPORT],
  ["/library at a width where every control is reachable", "/library", WIDE_VIEWPORT],
] as const) {
  test(`same URL, same controls, same books online and offline — ${label}`, async () => {
    const net = await network();
    const online = await launch(`${device.origin}${url}`, viewport);
    const onlineSnapshot = await readLibrary(online);
    await online.close();

    if (url === "/library") expectSeededLibrary(onlineSnapshot);
    expect(onlineSnapshot.path).toBe(url);

    await cutNetwork(device.page);
    net.reset();
    const offline = await launch(`${device.origin}${url}`, viewport);
    const offlineSnapshot = await readLibrary(offline);
    await offline.close();
    await expectNothingReachedTheServer(`launching ${url} offline`);

    expect(
      offlineSnapshot,
      `the library at ${url} rendered differently with the network gone. The read path is ` +
        "supposed to be local-only, so every difference here is the network leaking into it.",
    ).toStrictEqual(onlineSnapshot);
  });
}

// ---------------------------------------------------------------------------
// 2. Every control works offline
// ---------------------------------------------------------------------------

test("every library control works with the network gone", async () => {
  const net = await network();
  await cutNetwork(device.page);
  net.reset();

  const page = await launch(`${device.origin}/library`, WIDE_VIEWPORT);
  const search = page.getByRole("searchbox", { name: "Search your library" });
  const titles = async () => titlesOf(await readLibrary(page));

  // --- search filters, and clears
  await search.fill("Briarwood");
  await expect.poll(titles).toStrictEqual(["Parity Book Briarwood"]);
  await expect(page.getByRole("button", { name: "Clear search" })).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect.poll(titles).toHaveLength(VISIBLE_SEED_BOOKS.length);

  // Search reaches the fields the mirror indexes, not only the title: "Petra"
  // appears nowhere but one book's author.
  await search.fill("Petra");
  await expect
    .poll(titles, { message: "offline search did not match on the author field" })
    .toStrictEqual([SEED_BOOKS.find((book) => book.author.startsWith("Petra"))!.title]);
  await search.fill("no such book anywhere");
  await expect(page.getByRole("heading", { name: "No matching books" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect.poll(titles).toHaveLength(VISIBLE_SEED_BOOKS.length);

  // --- status filters
  for (const status of ["All", "In progress", "Not started", "Finished", "Archived"] as const) {
    const expected = SEED_BOOKS.filter((book) =>
      status === "All"
        ? book.status !== "archived"
        : book.status === status.toLowerCase().replace(" ", "-"),
    ).map((book) => book.title);
    await page.getByRole("button", { name: status, exact: true }).click();
    await expect
      .poll(async () => (await titles()).sort(), {
        message: `the "${status}" filter returned the wrong books with the network gone`,
      })
      .toStrictEqual(expected.sort());
  }
  await page.getByRole("button", { name: "All", exact: true }).click();

  // --- tag filters
  await expect(
    page.getByRole("button", { name: "#fiction" }),
    "the tag filter chips are not on screen with the network gone",
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "#fiction" }).click();
  await expect
    .poll(async () => (await titles()).sort())
    .toStrictEqual(
      SEED_BOOKS.filter((book) => book.tags.includes("fiction") && book.status !== "archived")
        .map((book) => book.title)
        .sort(),
    );
  await page.getByRole("button", { name: "#fiction" }).click();
  await expect.poll(titles).toHaveLength(VISIBLE_SEED_BOOKS.length);

  // --- the on-this-device facet
  await page.getByRole("button", { name: "On this device" }).click();
  await expect
    .poll(async () => (await titles()).sort())
    .toStrictEqual(
      VISIBLE_SEED_BOOKS.filter((book) => book.onDevice)
        .map((book) => book.title)
        .sort(),
    );
  await page.getByRole("button", { name: "On this device" }).click();
  await expect.poll(titles).toHaveLength(VISIBLE_SEED_BOOKS.length);

  // --- sort
  const sort = page.getByRole("combobox", { name: "Sort books" });
  await sort.selectOption("title");
  await expect
    .poll(titles, { message: "Title A–Z did not order the library by title offline" })
    .toStrictEqual(VISIBLE_SEED_BOOKS.map((book) => book.title).sort());
  await sort.selectOption("author");
  await expect
    .poll(titles, { message: "Author A–Z did not order the library by author offline" })
    .toStrictEqual(
      [...VISIBLE_SEED_BOOKS]
        .sort((left, right) => left.author.localeCompare(right.author))
        .map((book) => book.title),
    );
  await sort.selectOption("added");
  await expect
    .poll(titles, { message: "Recently added did not order the library by import time offline" })
    .toStrictEqual(
      [...IMPORT_ORDER]
        .reverse()
        .filter((book) => book.status !== "archived")
        .map((book) => book.title),
    );
  await sort.selectOption("activity");
  await expect
    .poll(async () => (await titles())[0], {
      message: "Recent activity did not put the most recently progressed book first offline",
    })
    .toBe(CONTINUE_BOOK.title);

  // --- the grid/list view toggle, at a width where it is on screen
  const beforeToggle = await readLibrary(page);
  expect(
    beforeToggle.viewSwitch.visible,
    `the view toggle is not on screen at ${WIDE_VIEWPORT.width}px, so this test would be ` +
      "silently skipping the control it exists to exercise",
  ).toBe(true);
  expect(beforeToggle.listMode).toBe(false);
  await page.getByRole("button", { name: "List view" }).click();
  await expect
    .poll(async () => (await readLibrary(page)).listMode, {
      message: "the list view toggle did nothing with the network gone",
    })
    .toBe(true);
  await page.getByRole("button", { name: "Grid view" }).click();
  await expect.poll(async () => (await readLibrary(page)).listMode).toBe(false);

  // --- the continue card, all the way into the player
  const continueCard = page.getByRole("link", {
    name: `Continue listening ${CONTINUE_BOOK.title}`,
  });
  await expect(continueCard).toBeVisible();
  await continueCard.click();
  await expect(
    page.getByRole("heading", { name: CONTINUE_BOOK.title }),
    "the continue card did not open this device's own copy of the book with the network gone",
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();

  await expectNothingReachedTheServer("exercising every control offline");
  await page.close();
});

// ---------------------------------------------------------------------------
// 3. Books whose audio is not on this device
// ---------------------------------------------------------------------------

test("books not on this device are marked, browsable, searchable and never playable", async () => {
  const net = await network();
  await cutNetwork(device.page);
  net.reset();

  const page = await launch(`${device.origin}/library`, WIDE_VIEWPORT);
  // List view is where a card offers a play control at all, so it is the only
  // view in which "never looks playable" is a claim with content.
  await page.getByRole("button", { name: "List view" }).click();
  await expect.poll(async () => (await readLibrary(page)).listMode).toBe(true);

  const snapshot = await readLibrary(page);
  for (const seed of VISIBLE_SEED_BOOKS) {
    const card = snapshot.books.find((book) => book.title === seed.title);
    expect(card, `"${seed.title}" is not in the library at all with the network gone`).toBeTruthy();
    if (seed.onDevice) {
      expect(card!.onDevice).toBe(true);
      // The size lives in the meta line, and still says what it means to a
      // screen reader rather than being a bare number next to a progress figure.
      expect(card!.deviceSize).toMatch(/^[\d.]+ (B|KB|MB|GB) on this device$/);
      expect(card!.deviceLine, "a downloaded book needs no missing-audio notice").toBe("");
      expect(card!.removeDownloadButton, "a downloaded book must offer removal").toBe(true);
      expect(card!.playLink, "a downloaded book must be playable offline").toBe(true);
      expect(card!.offDeviceBadge).toBe(false);
      continue;
    }
    // Visibly marked, in both places the design promises: on the cover and in
    // the card's own copy.
    expect(card!.offDeviceBadge, `"${seed.title}" is not marked on its cover`).toBe(true);
    expect(card!.deviceLine).toBe("Not on this device — re-import the MP3 to listen");
    // And never looks playable: no play link, only the inert stand-in.
    expect(card!.playLink, `"${seed.title}" offers a play affordance it cannot honour`).toBe(false);
    expect(card!.playUnavailable).toBe(true);
    expect(card!.removeDownloadButton).toBe(false);
  }

  // The same claim, made against the accessibility tree rather than class
  // names, so a renamed class cannot quietly turn this assertion vacuous.
  for (const seed of VISIBLE_SEED_BOOKS.filter((book) => !book.onDevice)) {
    const card = page.locator("article.book-item", { hasText: seed.title });
    await expect(card.getByRole("link", { name: `Play ${seed.title}` })).toHaveCount(0);
    await expect(card.getByText("Not on this device", { exact: false }).first()).toBeVisible();
  }
  for (const seed of VISIBLE_SEED_BOOKS.filter((book) => book.onDevice)) {
    const card = page.locator("article.book-item", { hasText: seed.title });
    await expect(card.getByRole("link", { name: `Play ${seed.title}` })).toHaveCount(1);
  }

  // Still browsable and searchable — the marking is not a way of hiding them.
  const offDevice = VISIBLE_SEED_BOOKS.filter((book) => !book.onDevice)[0]!;
  const search = page.getByRole("searchbox", { name: "Search your library" });
  await search.fill(offDevice.title.replace("Parity Book ", ""));
  await expect
    .poll(async () => titlesOf(await readLibrary(page)), {
      message: "a book whose audio is not on this device dropped out of search",
    })
    .toStrictEqual([offDevice.title]);
  const found = await readLibrary(page);
  expect(found.books[0]!.offDeviceBadge).toBe(true);
  expect(found.books[0]!.playLink).toBe(false);

  await expectNothingReachedTheServer("browsing not-on-device books offline");
  await page.close();
});

// ---------------------------------------------------------------------------
// 4. /offline is not a second UI
// ---------------------------------------------------------------------------

test("/offline lands in the unified library, online and offline", async () => {
  const net = await network();
  const reference = await launch(`${device.origin}/library`, WIDE_VIEWPORT);
  const referenceSnapshot = await readLibrary(reference);
  await reference.close();

  for (const mode of ["online", "offline"] as const) {
    if (mode === "offline") {
      await cutNetwork(device.page);
      net.reset();
    }
    const page = await launch(`${device.origin}/offline`, WIDE_VIEWPORT);
    await expect
      .poll(() => page.url().replace(device.origin, ""), {
        message: `/offline did not land in the unified library (${mode})`,
      })
      .toBe("/library");
    const snapshot = await readLibrary(page);
    expect(
      snapshot,
      `/offline rendered something other than the one library UI (${mode})`,
    ).toStrictEqual({ ...referenceSnapshot, path: "/library" });
    if (mode === "offline") await expectNothingReachedTheServer("landing on /offline offline");
    await page.close();
    if (mode === "offline") await restoreNetwork(device.page);
  }
});
