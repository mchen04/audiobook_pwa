import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";

import { database } from "./db";
import {
  applyPullBatch,
  getMirrorContinueBook,
  getSyncMeta,
  listMirrorBooks,
  listMirrorTagNames,
  purgeUser,
} from "./mirror";
import type { PullBatch, PulledBook } from "./sync-protocol";

const USER_A = "user-a";
const USER_B = "user-b";

function book(id: string, overrides: Partial<PulledBook> = {}): PulledBook {
  return {
    id,
    title: `Title ${id}`,
    author: "Author",
    narrator: null,
    description: null,
    series: null,
    seriesPosition: null,
    chapterDiagnostic: null,
    archivedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    media: {
      originalFilename: `${id}.mp3`,
      mimeType: "audio/mpeg",
      byteSize: 1_000_000,
      fingerprint: "f".repeat(64),
      fingerprintKind: "sha256-v1",
      durationMs: 3_600_000,
    },
    chapters: [{ position: 0, title: "Opening", startMs: 0, endMs: 3_600_000 }],
    tagIds: [],
    ...overrides,
  };
}

function batch(overrides: Partial<PullBatch> = {}): PullBatch {
  return {
    since: null,
    cursor: "2026-07-01T00:00:00.000Z",
    complete: true,
    books: [],
    playbackStates: [],
    tags: [],
    collections: [],
    preferences: null,
    listeningSessions: [],
    liveBookIds: null,
    ...overrides,
  };
}

function progress(bookId: string, positionMs: number, updatedAt: string, completed = false) {
  return {
    bookId,
    positionMs,
    playbackRate: 1,
    completed,
    deviceId: "device-1",
    deviceSequence: 1,
    eventOccurredAt: updatedAt,
    updatedAt,
  };
}

async function storeContents(store: string): Promise<unknown[]> {
  const db = await database();
  const rows = await db.getAll(store as "books");
  db.close();
  return rows;
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new FakeIDBFactory());
});

describe("applyPullBatch", () => {
  it("writes a whole batch across every affected store", async () => {
    await applyPullBatch(
      USER_A,
      batch({
        cursor: "2026-07-02T00:00:00.000Z",
        books: [book("book-1", { tagIds: ["tag-1"] })],
        playbackStates: [progress("book-1", 500, "2026-07-02T00:00:00.000Z")],
        tags: [{ id: "tag-1", name: "Fiction" }],
        collections: [
          {
            id: "coll-1",
            name: "Queue",
            updatedAt: "2026-07-01T00:00:00.000Z",
            books: [{ bookId: "book-1", position: 0 }],
          },
        ],
        preferences: {
          skipBackMs: 15_000,
          skipForwardMs: 30_000,
          smartRewind: true,
          autoplayNextInCollection: false,
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
        listeningSessions: [
          {
            id: "session-1",
            bookId: "book-1",
            startedAt: "2026-07-02T00:00:00.000Z",
            endedAt: "2026-07-02T00:10:00.000Z",
            startPositionMs: 0,
            endPositionMs: 500,
            listenedMs: 500,
          },
        ],
      }),
    );

    for (const store of [
      "books",
      "chapters",
      "playbackStates",
      "tags",
      "bookTags",
      "collections",
      "collectionBooks",
      "preferences",
      "listeningSessions",
    ]) {
      expect(await storeContents(store), `${store} written`).toHaveLength(1);
    }
    expect((await getSyncMeta(USER_A))?.cursor).toBe("2026-07-02T00:00:00.000Z");
  });

  it("applies nothing when a row late in the batch cannot be written", async () => {
    await applyPullBatch(USER_A, batch({ cursor: "2026-07-01T00:00:00.000Z" }));

    // Listening sessions are written after books, tags and collections, so a
    // failure here proves the earlier stores roll back rather than commit.
    const poisoned = batch({
      cursor: "2026-07-09T00:00:00.000Z",
      books: [book("book-1")],
      tags: [{ id: "tag-1", name: "Fiction" }],
      listeningSessions: [
        {
          id: "session-1",
          bookId: "book-1",
          startedAt: "2026-07-02T00:00:00.000Z",
          endedAt: "2026-07-02T00:10:00.000Z",
          startPositionMs: 0,
          endPositionMs: 500,
          listenedMs: () => 0,
        } as unknown as PullBatch["listeningSessions"][number],
      ],
    });

    await expect(applyPullBatch(USER_A, poisoned)).rejects.toThrow();

    expect(await storeContents("books")).toStrictEqual([]);
    expect(await storeContents("chapters")).toStrictEqual([]);
    expect(await storeContents("tags")).toStrictEqual([]);
    expect(await storeContents("listeningSessions")).toStrictEqual([]);
  });

  it("leaves the cursor where it was when the batch fails, so the pull re-fetches", async () => {
    await applyPullBatch(USER_A, batch({ cursor: "2026-07-01T00:00:00.000Z" }));
    expect((await getSyncMeta(USER_A))?.cursor).toBe("2026-07-01T00:00:00.000Z");

    const poisoned = batch({
      cursor: "2026-07-09T00:00:00.000Z",
      books: [book("book-1", { title: undefined as unknown as string, media: null })],
      listeningSessions: [
        {
          id: "s",
          bookId: "b",
          startedAt: "",
          endedAt: "",
          startPositionMs: 0,
          endPositionMs: 0,
          listenedMs: Symbol("nope"),
        } as unknown as PullBatch["listeningSessions"][number],
      ],
    });
    await expect(applyPullBatch(USER_A, poisoned)).rejects.toThrow();

    expect((await getSyncMeta(USER_A))?.cursor).toBe("2026-07-01T00:00:00.000Z");
  });

  it("replaces a book aggregate wholesale so removed chapters and tag edges go away", async () => {
    await applyPullBatch(
      USER_A,
      batch({
        books: [
          book("book-1", {
            tagIds: ["tag-1", "tag-2"],
            chapters: [
              { position: 0, title: "One", startMs: 0, endMs: 100 },
              { position: 1, title: "Two", startMs: 100, endMs: 200 },
              { position: 2, title: "Three", startMs: 200, endMs: 300 },
            ],
          }),
        ],
        tags: [
          { id: "tag-1", name: "Fiction" },
          { id: "tag-2", name: "Classics" },
        ],
      }),
    );
    expect(await storeContents("chapters")).toHaveLength(3);
    expect(await storeContents("bookTags")).toHaveLength(2);

    await applyPullBatch(
      USER_A,
      batch({
        books: [
          book("book-1", {
            tagIds: ["tag-1"],
            chapters: [{ position: 0, title: "One", startMs: 0, endMs: 100 }],
          }),
        ],
        tags: [{ id: "tag-1", name: "Fiction" }],
      }),
    );

    expect(await storeContents("chapters")).toHaveLength(1);
    expect(await storeContents("bookTags")).toHaveLength(1);
    expect(await storeContents("tags")).toHaveLength(1);
  });

  it("keeps another account's rows untouched", async () => {
    await applyPullBatch(USER_B, batch({ books: [book("book-b")] }));
    await applyPullBatch(USER_A, batch({ books: [book("book-a")] }));

    expect(await listMirrorBooks(USER_B)).toHaveLength(1);
    expect(await listMirrorBooks(USER_A)).toHaveLength(1);
  });
});

describe("tombstones", () => {
  const seeded = () =>
    batch({
      books: [book("book-1"), book("book-2")],
      playbackStates: [
        progress("book-1", 10, "2026-07-01T00:00:00.000Z"),
        progress("book-2", 20, "2026-07-01T00:00:00.000Z"),
      ],
      tags: [{ id: "tag-1", name: "Fiction" }],
      collections: [
        {
          id: "coll-1",
          name: "Queue",
          updatedAt: "2026-07-01T00:00:00.000Z",
          books: [
            { bookId: "book-1", position: 0 },
            { bookId: "book-2", position: 1 },
          ],
        },
      ],
      listeningSessions: [
        {
          id: "session-2",
          bookId: "book-2",
          startedAt: "2026-07-02T00:00:00.000Z",
          endedAt: "2026-07-02T00:10:00.000Z",
          startPositionMs: 0,
          endPositionMs: 20,
          listenedMs: 20,
        },
      ],
    });

  it("never treats absence from a page as a deletion", async () => {
    await applyPullBatch(USER_A, seeded());

    // A later page carries only book-1 and no live-id manifest at all.
    await applyPullBatch(
      USER_A,
      batch({ complete: false, books: [book("book-1")], liveBookIds: null }),
    );

    expect((await listMirrorBooks(USER_A)).map((row) => row.id).sort()).toStrictEqual([
      "book-1",
      "book-2",
    ]);
  });

  it("deletes a book and everything hanging off it when the manifest omits it", async () => {
    await applyPullBatch(USER_A, seeded());

    // The collection still claims both books; the tombstone must win, or a
    // deleted book would linger as a dangling membership row.
    await applyPullBatch(USER_A, batch({ ...seeded(), books: [], liveBookIds: ["book-1"] }));

    expect((await listMirrorBooks(USER_A)).map((row) => row.id)).toStrictEqual(["book-1"]);
    expect(await storeContents("playbackStates")).toHaveLength(1);
    expect(await storeContents("chapters")).toHaveLength(1);
    expect(await storeContents("collectionBooks")).toHaveLength(1);
    expect(await storeContents("listeningSessions")).toStrictEqual([]);
  });

  it("deletes a tombstoned book and everything hanging off it on an incremental pull", async () => {
    await applyPullBatch(USER_A, seeded());

    await applyPullBatch(
      USER_A,
      batch({
        since: "2026-07-01T00:00:00.000000Z",
        tombstones: [{ bookId: "book-2", deletedAt: "2026-07-03T00:00:00.000000Z" }],
      }),
    );

    expect((await listMirrorBooks(USER_A)).map((row) => row.id)).toStrictEqual(["book-1"]);
    expect(await storeContents("listeningSessions")).toStrictEqual([]);
  });

  it("ignores a tombstone for a book this device never held", async () => {
    await applyPullBatch(USER_A, seeded());

    await applyPullBatch(
      USER_A,
      batch({
        since: "2026-07-01T00:00:00.000000Z",
        tombstones: [{ bookId: "book-elsewhere", deletedAt: "2026-07-03T00:00:00.000000Z" }],
      }),
    );

    expect(await listMirrorBooks(USER_A)).toHaveLength(2);
  });

  it("keeps snapshot stores untouched by an interim page's empty streams", async () => {
    await applyPullBatch(USER_A, seeded());

    await applyPullBatch(
      USER_A,
      batch({ complete: false, tags: [], collections: [], listeningSessions: [] }),
    );

    expect(await listMirrorTagNames(USER_A)).toStrictEqual(["Fiction"]);
    expect(await storeContents("collections")).toHaveLength(1);
    expect(await storeContents("listeningSessions")).toHaveLength(1);
  });

  it("does not delete another account's books through one account's manifest", async () => {
    await applyPullBatch(USER_B, batch({ books: [book("book-b")] }));
    await applyPullBatch(USER_A, seeded());

    await applyPullBatch(USER_A, batch({ liveBookIds: [] }));

    expect(await listMirrorBooks(USER_A)).toStrictEqual([]);
    expect(await listMirrorBooks(USER_B)).toHaveLength(1);
  });

  it("drops a tag removed from the full vocabulary pull", async () => {
    await applyPullBatch(
      USER_A,
      batch({
        books: [book("book-1", { tagIds: ["tag-1", "tag-2"] })],
        tags: [
          { id: "tag-1", name: "Fiction" },
          { id: "tag-2", name: "Classics" },
        ],
      }),
    );
    expect(await listMirrorTagNames(USER_A)).toStrictEqual(["Classics", "Fiction"]);

    await applyPullBatch(USER_A, batch({ tags: [{ id: "tag-1", name: "Fiction" }] }));

    expect(await listMirrorTagNames(USER_A)).toStrictEqual(["Fiction"]);
  });

  it("drops a collection and its membership removed from the full pull", async () => {
    await applyPullBatch(
      USER_A,
      batch({
        books: [book("book-1")],
        collections: [
          {
            id: "coll-1",
            name: "Queue",
            updatedAt: "2026-07-01T00:00:00.000Z",
            books: [{ bookId: "book-1", position: 0 }],
          },
        ],
      }),
    );

    await applyPullBatch(USER_A, batch({ collections: [] }));

    expect(await storeContents("collections")).toStrictEqual([]);
    expect(await storeContents("collectionBooks")).toStrictEqual([]);
  });
});

describe("purgeUser", () => {
  it("removes every row of one account from every mirror store and no other", async () => {
    const populated = (prefix: string) =>
      batch({
        books: [book(`${prefix}-book`, { tagIds: [`${prefix}-tag`] })],
        playbackStates: [progress(`${prefix}-book`, 10, "2026-07-01T00:00:00.000Z")],
        tags: [{ id: `${prefix}-tag`, name: `${prefix} tag` }],
        collections: [
          {
            id: `${prefix}-coll`,
            name: "Queue",
            updatedAt: "2026-07-01T00:00:00.000Z",
            books: [{ bookId: `${prefix}-book`, position: 0 }],
          },
        ],
        preferences: {
          skipBackMs: 15_000,
          skipForwardMs: 30_000,
          smartRewind: true,
          autoplayNextInCollection: false,
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
        listeningSessions: [
          {
            id: `${prefix}-session`,
            bookId: `${prefix}-book`,
            startedAt: "2026-07-02T00:00:00.000Z",
            endedAt: "2026-07-02T00:10:00.000Z",
            startPositionMs: 0,
            endPositionMs: 10,
            listenedMs: 10,
          },
        ],
      });
    await applyPullBatch(USER_A, populated("a"));
    await applyPullBatch(USER_B, populated("b"));

    await purgeUser(USER_A);

    const stores = [
      "books",
      "chapters",
      "playbackStates",
      "tags",
      "bookTags",
      "collections",
      "collectionBooks",
      "preferences",
      "listeningSessions",
      "syncMeta",
    ];
    const db = await database();
    for (const store of stores) {
      const rows = (await db.getAll(store as "books")) as { userId: string }[];
      expect(
        rows.map((row) => row.userId),
        `${store} after purge`,
      ).toStrictEqual([USER_B]);
    }
    db.close();
  });
});

describe("local library reads", () => {
  const library = () =>
    batch({
      books: [
        book("book-dune", {
          title: "Dune",
          author: "Frank Herbert",
          narrator: "Simon Vance",
          series: "Dune Chronicles",
          updatedAt: "2026-07-03T00:00:00.000Z",
          createdAt: "2026-01-03T00:00:00.000Z",
          tagIds: ["tag-scifi"],
        }),
        book("book-emma", {
          title: "Emma",
          author: "Jane Austen",
          updatedAt: "2026-07-01T00:00:00.000Z",
          createdAt: "2026-01-02T00:00:00.000Z",
          tagIds: ["tag-classics"],
        }),
        book("book-ilium", {
          title: "Ilium",
          author: "Dan Simmons",
          updatedAt: "2026-07-02T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        book("book-attic", {
          title: "Attic Notes",
          author: "Anon",
          archivedAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          createdAt: "2026-01-04T00:00:00.000Z",
        }),
      ],
      playbackStates: [
        progress("book-dune", 5_000, "2026-07-10T00:00:00.000Z"),
        progress("book-emma", 900, "2026-07-11T00:00:00.000Z"),
        progress("book-ilium", 0, "2026-07-09T00:00:00.000Z", true),
      ],
      tags: [
        { id: "tag-scifi", name: "Sci-Fi" },
        { id: "tag-classics", name: "Classics" },
      ],
    });

  beforeEach(async () => {
    await applyPullBatch(USER_A, library());
  });

  it("hides archived books from every non-archived status", async () => {
    expect((await listMirrorBooks(USER_A)).map((row) => row.id)).not.toContain("book-attic");
    expect(
      (await listMirrorBooks(USER_A, { status: "archived" })).map((row) => row.id),
    ).toStrictEqual(["book-attic"]);
  });

  it("splits in-progress, not-started and finished the way the server does", async () => {
    const ids = async (status: "in-progress" | "not-started" | "finished") =>
      (await listMirrorBooks(USER_A, { status })).map((row) => row.id).sort();
    expect(await ids("in-progress")).toStrictEqual(["book-dune", "book-emma"]);
    expect(await ids("finished")).toStrictEqual(["book-ilium"]);
    expect(await ids("not-started")).toStrictEqual([]);
  });

  it("searches title, author, narrator, series and tag names", async () => {
    const ids = async (query: string) =>
      (await listMirrorBooks(USER_A, { query })).map((row) => row.id);
    expect(await ids("herbert")).toStrictEqual(["book-dune"]);
    expect(await ids("simon vance")).toStrictEqual(["book-dune"]);
    expect(await ids("chronicles")).toStrictEqual(["book-dune"]);
    expect(await ids("classics")).toStrictEqual(["book-emma"]);
    expect(await ids("no such book")).toStrictEqual([]);
  });

  it("filters by an exact tag name", async () => {
    expect((await listMirrorBooks(USER_A, { tag: "Sci-Fi" })).map((row) => row.id)).toStrictEqual([
      "book-dune",
    ]);
    expect(await listMirrorBooks(USER_A, { tag: "Nonexistent" })).toStrictEqual([]);
  });

  it("sorts by title, author, added and activity", async () => {
    const ids = async (sort: "title" | "author" | "added" | "activity") =>
      (await listMirrorBooks(USER_A, { sort })).map((row) => row.id);
    expect(await ids("title")).toStrictEqual(["book-dune", "book-emma", "book-ilium"]);
    expect(await ids("author")).toStrictEqual(["book-ilium", "book-dune", "book-emma"]);
    expect(await ids("added")).toStrictEqual(["book-dune", "book-emma", "book-ilium"]);
    // Activity is the later of the metadata edit and the last listen.
    expect(await ids("activity")).toStrictEqual(["book-emma", "book-dune", "book-ilium"]);
  });

  it("attaches tag names and duration to each row", async () => {
    const [dune] = await listMirrorBooks(USER_A, { query: "dune" });
    expect(dune?.tags).toStrictEqual(["Sci-Fi"]);
    expect(dune?.durationMs).toBe(3_600_000);
    expect(dune?.positionMs).toBe(5_000);
  });

  it("picks the most recently progressed unfinished book to continue", async () => {
    expect((await getMirrorContinueBook(USER_A))?.id).toBe("book-emma");
  });

  it("has nothing to continue when every book is finished, archived or untouched", async () => {
    await purgeUser(USER_A);
    await applyPullBatch(
      USER_A,
      batch({
        books: [book("book-1")],
        playbackStates: [progress("book-1", 0, "2026-07-01T00:00:00.000Z")],
      }),
    );
    expect(await getMirrorContinueBook(USER_A)).toBe(null);
  });
});

describe("scale", () => {
  it("lists, filters and sorts a thousand-book library from local data alone", async () => {
    const pad = (index: number) => String(index).padStart(4, "0");
    await applyPullBatch(
      USER_A,
      batch({
        books: Array.from({ length: 1_000 }, (_unused, index) =>
          book(`book-${pad(index)}`, {
            title: `Title ${pad(index)}`,
            author: `Author ${pad(index % 50)}`,
            updatedAt: `2026-07-01T00:00:${pad(index % 60).slice(2)}.000Z`,
            tagIds: index % 10 === 0 ? ["tag-1"] : [],
          }),
        ),
        tags: [{ id: "tag-1", name: "Fiction" }],
      }),
    );

    const started = performance.now();
    const all = await listMirrorBooks(USER_A, { sort: "title" });
    const tagged = await listMirrorBooks(USER_A, { tag: "Fiction" });
    const searched = await listMirrorBooks(USER_A, { query: "title 0777" });
    const elapsed = performance.now() - started;

    expect(all).toHaveLength(1_000);
    expect(all[0]?.id).toBe("book-0000");
    expect(tagged).toHaveLength(100);
    expect(searched.map((row) => row.id)).toStrictEqual(["book-0777"]);
    // Three full passes over a thousand books; a per-row IndexedDB lookup
    // would be orders of magnitude slower than this ceiling.
    expect(elapsed).toBeLessThan(1_000);
  });
});
