import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  APP_ORIGIN,
  attachDriver,
  closeSql,
  commit,
  createCollection,
  drainOutbox,
  mirror,
  openDevice,
  pull,
  resetAccount,
  sharedSession,
  sql,
  type Account,
  type StorageState,
} from "./harness/app";
import { readBookIds, readCollectionIds, readTagIds, toDeviceState } from "./harness/state";

/** `collections.updatedAt` straight from Postgres, as microsecond-comparable text. */
async function collectionUpdatedAt(collectionId: string): Promise<string | null> {
  const [row] = await sql()<{ updated_at: Date }[]>`
    SELECT updated_at FROM collections WHERE id = ${collectionId}::uuid
  `;
  return row ? row.updated_at.toISOString() : null;
}

/** `books.updatedAt` straight from Postgres. */
async function bookUpdatedAt(bookId: string): Promise<string | null> {
  const [row] = await sql()<{ updated_at: Date }[]>`
    SELECT updated_at FROM books WHERE id = ${bookId}::uuid
  `;
  return row ? row.updated_at.toISOString() : null;
}

/**
 * Two devices, one account.
 *
 * The device id is stamped into localStorage before any app script runs, so
 * these really are two devices and not two tabs — `chapterline:device-id` is
 * the key the whole progress-ordering policy hangs off, and two contexts that
 * minted the same one would make every assertion here vacuous. The ids are
 * asserted distinct before anything else runs.
 *
 * The case this file exists for is design contract section 3: `chapters`,
 * `book_tags` and `collection_books` carry no `updatedAt`, so a change to one
 * of them propagates ONLY because the parent aggregate's `updatedAt` is bumped.
 * Device B pulls INCREMENTALLY (it already holds a cursor), which is the only
 * way that failure is observable — a full pull would mask a missing bump.
 */

const DURATION_MS = 600_000;
const DEVICE_A = "device-a-converge-0001";
const DEVICE_B = "device-b-converge-0002";

let session: { account: Account; storageState: StorageState } | null = null;

test.afterAll(async () => {
  await closeSql();
});

function chapterList() {
  return [
    { position: 0, title: "Opening", startMs: 0, endMs: 300_000 },
    { position: 1, title: "Close", startMs: 300_000, endMs: DURATION_MS },
  ];
}

function importPayload(fingerprint: string, title: string) {
  return {
    fileName: encodeURIComponent(`${fingerprint.slice(0, 10)}.mp3`),
    byteSize: 2_097_152,
    durationMs: DURATION_MS,
    fingerprint,
    fingerprintKind: "sha256-v1",
    title,
    author: "Convergence Author",
    narrator: null,
    chapterDiagnostic: null,
    chapters: chapterList(),
  };
}

/** `media_assets.fingerprint` is validated as 64 lowercase hex characters. */
function fingerprint(tag: string): string {
  const hex = [...tag].map((character) => character.charCodeAt(0).toString(16)).join("");
  return hex.padStart(64, "a").slice(-64);
}

type Device = { context: BrowserContext; page: Page; id: string };

async function bringUp(
  browser: Parameters<typeof openDevice>[0],
  account: Account,
  storageState: StorageState,
  deviceId: string,
): Promise<Device> {
  const { context, page } = await openDevice(browser, deviceId, storageState);
  await page.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
  await attachDriver(page, account, deviceId);
  return { context, page, id: deviceId };
}

async function setUpPair(
  browser: Parameters<typeof openDevice>[0],
): Promise<{ account: Account; a: Device; b: Device }> {
  session ??= await sharedSession(browser);
  const { account, storageState } = session;
  await resetAccount(account.userId);
  const a = await bringUp(browser, account, storageState, DEVICE_A);
  const b = await bringUp(browser, account, storageState, DEVICE_B);

  const ids = await Promise.all(
    [a, b].map((device) =>
      device.page.evaluate(() => localStorage.getItem("chapterline:device-id")),
    ),
  );
  expect(
    new Set(ids).size,
    `both contexts report device id ${ids[0]}, so this is one device pretending to be two`,
  ).toBe(2);
  return { account, a, b };
}

/** A book on the server, addressable from both devices, with both mirrors current. */
async function seedBook(account: Account, a: Device, b: Device, tag: string, title: string) {
  const media = fingerprint(tag);
  await commit(a.page, {
    kind: "import",
    fingerprint: media,
    payload: importPayload(media, title),
  });
  await drainOutbox(a.page);
  expect(await pull(a.page)).toBe("applied");
  expect(await pull(b.page)).toBe("applied");
  const bookId = (await readBookIds(account.userId)).get(media);
  expect(bookId, "the import never reached the server").toBeTruthy();
  return { media, bookId: bookId! };
}

test("a collection membership change on one device reaches the other on an incremental pull", async ({
  browser,
}) => {
  const { account, a, b } = await setUpPair(browser);
  try {
    const book = await seedBook(account, a, b, "col1", "Collection Subject");
    const collectionId = await createCollection(a.page, "Shared Shelf");
    // Both devices take a cursor BEFORE the change, so the pull below is
    // incremental. That is the only shape in which a missing parent bump is
    // observable: a full pull would carry the edge regardless.
    expect(await pull(a.page)).toBe("applied");
    expect(await pull(b.page)).toBe("applied");
    const cursorBefore = (await mirror(b.page)).syncMeta?.cursor;
    expect(
      cursorBefore,
      "device B has no pull cursor, so its next pull would be a full sync",
    ).toBeTruthy();

    const bumpBefore = await collectionUpdatedAt(collectionId);
    await commit(a.page, {
      kind: "collection",
      collectionId,
      bookId: book.bookId,
      include: true,
    });
    await drainOutbox(a.page);

    // The parent bump itself, asserted at runtime.
    //
    // Design contract section 3 requires a membership change to move
    // `collections.updatedAt`, and `src/server/sync/parent-updated-at.test.ts`
    // guards it at the source level. It has to be checked directly here because
    // the pull sends the collection list IN FULL on every sync
    // (`pull.ts#loadCollections` applies no cursor), so membership would still
    // reach device B with the bump removed — the propagation check below cannot
    // see this failure, and a verifier that only ran it would report a green
    // suite while the contract was broken.
    const bumpAfter = await collectionUpdatedAt(collectionId);
    expect(
      bumpAfter && bumpBefore && bumpAfter > bumpBefore,
      `adding a book to a collection did not move collections.updatedAt ` +
        `(${bumpBefore} -> ${bumpAfter}). \`collection_books\` carries no updatedAt of its own, ` +
        "so the parent bump is the only timestamp that records the change.",
    ).toBe(true);

    expect(await pull(b.page)).toBe("applied");
    const onB = toDeviceState(await mirror(b.page));
    expect(
      [...(onB.collectionMembers.get("Shared Shelf") || [])],
      "device A put the book in a collection and device B never saw it",
    ).toStrictEqual([book.media]);

    // And the reverse direction, so the test is about propagation rather than
    // about one lucky ordering.
    await commit(b.page, {
      kind: "collection",
      collectionId,
      bookId: book.bookId,
      include: false,
    });
    await drainOutbox(b.page);
    expect(await pull(a.page)).toBe("applied");
    const onA = toDeviceState(await mirror(a.page));
    expect(
      [...(onA.collectionMembers.get("Shared Shelf") || [])],
      "device B removed the book from the collection and device A never saw the removal",
    ).toStrictEqual([]);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("a tag change on one device reaches the other on an incremental pull", async ({ browser }) => {
  const { account, a, b } = await setUpPair(browser);
  try {
    const book = await seedBook(account, a, b, "tag1", "Tag Subject");
    expect(await pull(b.page)).toBe("applied");
    const cursorBefore = (await mirror(b.page)).syncMeta?.cursor;
    expect(cursorBefore, "device B has no pull cursor").toBeTruthy();

    const bumpBefore = await bookUpdatedAt(book.bookId);
    await commit(a.page, {
      kind: "rename",
      bookId: book.bookId,
      fields: { tags: ["fiction", "reread"] },
    });
    await drainOutbox(a.page);
    const bumpAfter = await bookUpdatedAt(book.bookId);
    expect(
      bumpAfter && bumpBefore && bumpAfter > bumpBefore,
      `a tag edit did not move books.updatedAt (${bumpBefore} -> ${bumpAfter}). Unlike the ` +
        "collection list, book aggregates ARE cursored, so this bump is the only thing that " +
        "puts the change in another device's incremental pull.",
    ).toBe(true);

    expect(await pull(b.page)).toBe("applied");
    const onB = toDeviceState(await mirror(b.page));
    expect(
      [...(onB.tagsByFingerprint.get(book.media) || [])].sort(),
      "device A tagged the book and device B's incremental pull never saw it. `book_tags` " +
        "carries no updatedAt, so this is the parent bump on `books.updatedAt` failing " +
        "(design contract section 3).",
    ).toStrictEqual(["fiction", "reread"]);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("a tag EDGE queued through commitTagEdge reaches the other device", async ({ browser }) => {
  const { account, a, b } = await setUpPair(browser);
  try {
    const book = await seedBook(account, a, b, "tag2", "Tag Edge Subject");
    // The vocabulary has to exist before an edge can name a tag id.
    await commit(a.page, {
      kind: "rename",
      bookId: book.bookId,
      fields: { tags: ["fiction"] },
    });
    await drainOutbox(a.page);
    const tagIds = await readTagIds(account.userId);
    const fictionId = tagIds.get("fiction");
    expect(fictionId, "the tag vocabulary was not created").toBeTruthy();

    expect(await pull(a.page)).toBe("applied");
    expect(await pull(b.page)).toBe("applied");

    // The production tag-edge mutation, exactly as `src/lib/offline/outbox.ts`
    // exposes it. This is the mutation a "remove this tag" control would queue.
    await commit(a.page, {
      kind: "tag",
      bookId: book.bookId,
      tagId: fictionId!,
      include: false,
    });
    await drainOutbox(a.page);

    expect(await pull(b.page)).toBe("applied");
    const onB = toDeviceState(await mirror(b.page));
    expect(
      [...(onB.tagsByFingerprint.get(book.media) || [])].sort(),
      "device A removed a tag edge through commitTagEdge and the queue drained clean, but " +
        "device B still holds the tag. The mutation was acknowledged and deleted from the " +
        "outbox without ever being applied — a silent lost write.",
    ).toStrictEqual([]);

    // And the same edge added back.
    await commit(a.page, {
      kind: "tag",
      bookId: book.bookId,
      tagId: fictionId!,
      include: true,
    });
    await drainOutbox(a.page);
    expect(await pull(b.page)).toBe("applied");
    expect(
      [...(toDeviceState(await mirror(b.page)).tagsByFingerprint.get(book.media) || [])],
      "device A added a tag edge through commitTagEdge and device B never saw it",
    ).toStrictEqual(["fiction"]);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("two devices editing different books converge on the same state", async ({ browser }) => {
  const { account, a, b } = await setUpPair(browser);
  try {
    const left = await seedBook(account, a, b, "conv1", "Left Book");
    const right = await seedBook(account, a, b, "conv2", "Right Book");
    const collectionId = await createCollection(a.page, "Converged");
    expect(await pull(a.page)).toBe("applied");
    expect(await pull(b.page)).toBe("applied");

    // Simultaneous, on different books, from two devices with the network up.
    await Promise.all([
      commit(a.page, {
        kind: "rename",
        bookId: left.bookId,
        fields: { title: "Left Renamed By A" },
      }),
      commit(b.page, {
        kind: "rename",
        bookId: right.bookId,
        fields: { title: "Right Renamed By B" },
      }),
    ]);
    await commit(a.page, { kind: "archive", bookId: left.bookId, archived: true });
    await commit(b.page, {
      kind: "collection",
      collectionId,
      bookId: right.bookId,
      include: true,
    });
    await drainOutbox(a.page);
    await drainOutbox(b.page);

    expect(await pull(a.page)).toBe("applied");
    expect(await pull(b.page)).toBe("applied");

    const stateA = toDeviceState(await mirror(a.page));
    const stateB = toDeviceState(await mirror(b.page));

    const describe = (state: typeof stateA) =>
      [...state.booksByFingerprint.entries()]
        .sort()
        .map(
          ([media, row]) =>
            `${media.slice(-6)} "${row.title}" archived=${row.archived} chapters=${row.chapterCount}`,
        );

    // Each device must see BOTH edits, including the one it did not make.
    expect(describe(stateA), "device A does not hold what the pair agreed on").toStrictEqual([
      `${left.media.slice(-6)} "Left Renamed By A" archived=true chapters=2`,
      `${right.media.slice(-6)} "Right Renamed By B" archived=false chapters=2`,
    ]);
    expect(describe(stateB), "the two devices did not converge").toStrictEqual(describe(stateA));
    expect(
      [...(stateA.collectionMembers.get("Converged") || [])],
      "device B's collection edit never reached device A",
    ).toStrictEqual([right.media]);
    expect([...(stateB.collectionMembers.get("Converged") || [])]).toStrictEqual([right.media]);

    // …and both must match the server, not merely each other. Two devices that
    // agreed on a stale copy would satisfy the check above.
    const collections = await readCollectionIds(account.userId);
    expect(collections.get("Converged")).toBe(collectionId);
    const serverBooks = await readBookIds(account.userId);
    expect([...serverBooks.keys()].sort()).toStrictEqual([left.media, right.media].sort());
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
