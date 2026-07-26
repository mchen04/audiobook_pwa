import { expect, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  apiCall,
  importThroughUi,
  openDevice,
  resetAccount,
  type Account,
  type StorageState,
} from "./app";

/**
 * A library worth comparing.
 *
 * The parity gate is only as strong as the library it runs against: two empty
 * screens match perfectly. So the account is seeded with books in every state
 * the library can show — on this device and not, started, untouched, finished
 * and archived, tagged and untagged — and every one of them is created through
 * the shipping paths (`local-import.ts`, `POST /api/books/local`, the mutation
 * routes and `GET /api/sync/pull`). Nothing is written into Postgres behind the
 * app's back, so nothing here can seed a state the product cannot produce.
 *
 * "Not on this device" is produced the way a user produces it: a SECOND device
 * imports the book, and this device learns about it from a pull. The audio
 * genuinely is somewhere else, which is the condition section 9 is about.
 */

const FIXTURE = path.join(process.cwd(), "tests/fixtures/Downloads/Chapterline-iPhone-Test.mp3");

/**
 * The fixture's ID3v2 frames are UTF-8 with declared byte lengths, so a title
 * of exactly 21 characters and an artist of exactly 14 can be swapped in
 * without rewriting frame headers. That gives six genuinely distinct books
 * (distinct titles, distinct authors, distinct sha256 fingerprints) from one
 * small fixture, instead of six copies of the same one.
 */
const FIXTURE_TITLE = "iPhone Downloads Test";
const FIXTURE_AUTHOR = "Chapterline QA";

export type SeedBook = {
  title: string;
  author: string;
  /** Imported by this device (true) or by the other one (false). */
  onDevice: boolean;
  tags: string[];
  status: "in-progress" | "not-started" | "finished" | "archived";
  /** Ranks the continue card: the highest positive number wins. */
  continueRank: number;
  positionMs: number;
  completed: boolean;
};

export const SEED_BOOKS: SeedBook[] = [
  {
    title: "Parity Book Aldertown",
    author: "Sami Zephyrton",
    onDevice: true,
    tags: [],
    status: "in-progress",
    continueRank: 2,
    positionMs: 4_000,
    completed: false,
  },
  {
    title: "Parity Book Briarwood",
    author: "Rosa Yarrowfen",
    onDevice: true,
    tags: ["fiction"],
    status: "not-started",
    continueRank: 0,
    positionMs: 0,
    completed: false,
  },
  {
    title: "Parity Book Cinderfen",
    author: "Quin Windmoore",
    onDevice: true,
    tags: [],
    status: "finished",
    continueRank: 0,
    positionMs: 9_000,
    completed: true,
  },
  {
    title: "Parity Book Duskhaven",
    author: "Petra Vellwood",
    onDevice: false,
    tags: ["fiction"],
    status: "not-started",
    continueRank: 0,
    positionMs: 0,
    completed: false,
  },
  {
    title: "Parity Book Emberwyck",
    author: "Owen Umberhale",
    onDevice: false,
    tags: ["epic"],
    status: "in-progress",
    continueRank: 1,
    positionMs: 3_000,
    completed: false,
  },
  {
    title: "Parity Book Fallowmar",
    author: "Nadia Torrance",
    onDevice: false,
    tags: [],
    status: "archived",
    continueRank: 0,
    positionMs: 0,
    completed: false,
  },
];

/** Books the default "All" view shows: everything that is not archived. */
export const VISIBLE_SEED_BOOKS = SEED_BOOKS.filter((book) => book.status !== "archived");

/**
 * The order `seedLibrary` registers the books in, oldest first. The other
 * device imports its three before this one does, so "Recently added" has a
 * known answer that is not simply the declaration order above.
 */
export const IMPORT_ORDER: SeedBook[] = [
  ...SEED_BOOKS.filter((book) => !book.onDevice),
  ...SEED_BOOKS.filter((book) => book.onDevice),
];

export const CONTINUE_BOOK = SEED_BOOKS.reduce((best, book) =>
  book.continueRank > best.continueRank ? book : best,
);

const PARITY_DEVICE_ID = "parity-device-000000001";

/** One book's bytes: the fixture with its tags rewritten and a unique tail. */
export function bookBuffer(book: SeedBook, index: number): Buffer {
  const source = readFileSync(FIXTURE);
  expect(
    book.title.length === FIXTURE_TITLE.length && book.author.length === FIXTURE_AUTHOR.length,
    `seed book "${book.title}" must keep the fixture's ID3 field lengths ` +
      `(${FIXTURE_TITLE.length} title / ${FIXTURE_AUTHOR.length} author) or the frame headers lie`,
  ).toBe(true);
  const patched = Buffer.from(
    source
      .toString("latin1")
      .replace(FIXTURE_TITLE, book.title)
      .replace(FIXTURE_AUTHOR, book.author),
    "latin1",
  );
  // A distinct tail means a distinct sha256, so the server registers a distinct
  // book rather than answering 409 and merging into the first one. MPEG
  // decoders ignore trailing bytes, so the audio is unchanged.
  return Buffer.concat([patched, Buffer.alloc(64 + index * 16)]);
}

function bookLink(page: Page, title: string) {
  return page.getByRole("link", { name: title, exact: true });
}

/**
 * Wipes the account and rebuilds it. Returns nothing the tests assert on — the
 * expectations live in `SEED_BOOKS`, so a seeding bug shows up as a failed
 * expectation rather than as a quietly agreeing pair of snapshots.
 */
export async function seedLibrary(
  browser: Browser,
  account: Account,
  storageState: StorageState,
  device: { page: Page },
): Promise<void> {
  await resetAccount(account.userId);

  const remoteBooks = SEED_BOOKS.filter((book) => !book.onDevice);
  const remote = await openDevice(browser, { storageState, deviceId: "parity-other-device-0001" });
  try {
    await remote.page.goto(`${remote.origin}/library`, { waitUntil: "domcontentloaded" });
    await remote.page.waitForSelector("[data-launch-ready]", { state: "attached" });
    for (const book of remoteBooks) {
      await importThroughUi(
        remote.page,
        `${book.title}.mp3`,
        bookBuffer(book, SEED_BOOKS.indexOf(book)),
      );
      await expect(bookLink(remote.page, book.title)).toBeVisible({ timeout: 60_000 });
    }
  } finally {
    await remote.context.close();
  }

  const page = device.page;
  for (const book of SEED_BOOKS.filter((entry) => entry.onDevice)) {
    await importThroughUi(page, `${book.title}.mp3`, bookBuffer(book, SEED_BOOKS.indexOf(book)));
    await expect(bookLink(page, book.title)).toBeVisible({ timeout: 60_000 });
  }

  const ids = await bookIdsByTitle(page);
  for (const book of SEED_BOOKS) {
    expect(ids.get(book.title), `seed book "${book.title}" was never registered`).toBeTruthy();
  }

  // Tags and the archive flag, through the shipping mutation route.
  for (const book of SEED_BOOKS) {
    const patch: Record<string, unknown> = {};
    if (book.tags.length) patch.tags = book.tags;
    if (book.status === "archived") patch.archived = true;
    if (!Object.keys(patch).length) continue;
    const response = await apiCall(page, "PATCH", `/api/books/${ids.get(book.title)}`, patch);
    expect(response.status, `tagging/archiving "${book.title}" failed`).toBe(200);
  }

  // Progress last, in continue-rank order, so the continue card is the book
  // this seed says it is rather than whichever write happened to land last.
  const progressed = SEED_BOOKS.filter((book) => book.positionMs > 0 || book.completed).sort(
    (left, right) => left.continueRank - right.continueRank,
  );
  let occurredAt = Date.now() - progressed.length * 1000;
  for (const book of progressed) {
    occurredAt += 1000;
    const response = await apiCall(page, "PATCH", `/api/books/${ids.get(book.title)}/progress`, {
      deviceId: PARITY_DEVICE_ID,
      deviceSequence: 1,
      positionMs: book.positionMs,
      playbackRate: 1,
      completed: book.completed,
      eventOccurredAt: new Date(occurredAt).toISOString(),
    });
    expect(response.status, `setting progress on "${book.title}" failed`).toBeLessThan(300);
  }
}

async function bookIdsByTitle(page: Page): Promise<Map<string, string>> {
  const response = await apiCall(page, "GET", "/api/books?status=all");
  expect(response.status, "listing the seeded books failed").toBe(200);
  const archived = await apiCall(page, "GET", "/api/books?status=archived");
  const rows = [
    ...((response.body as { books?: Array<{ id: string; title: string }> }).books ?? []),
    ...((archived.body as { books?: Array<{ id: string; title: string }> }).books ?? []),
  ];
  return new Map(rows.map((row) => [row.title, row.id]));
}

/**
 * Brings this device's mirror up to date with everything the seed created, and
 * refuses to continue until it has. Every later comparison assumes the device
 * already knows about all six books; a race here would show up as an unstable
 * parity failure instead of as the setup problem it is.
 */
export async function waitForSeededMirror(page: Page, origin: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.goto(`${origin}/library`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 30_000 });
        const titles = await page.evaluate(() =>
          [...document.querySelectorAll("article.book-item .book-title")].map((node) =>
            (node.textContent ?? "").trim(),
          ),
        );
        return titles.sort();
      },
      {
        timeout: 90_000,
        message: "this device's mirror never caught up with the seeded library",
      },
    )
    .toEqual(VISIBLE_SEED_BOOKS.map((book) => book.title).sort());
}
