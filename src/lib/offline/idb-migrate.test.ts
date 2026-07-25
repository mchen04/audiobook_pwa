import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { openDB, type IDBPDatabase } from "idb";

import { database as openOfflineDatabase } from "./db";

/**
 * Migration ground truth for both on-device IndexedDB databases.
 *
 * Every historical schema version is rebuilt here as a raw fixture — exactly
 * the stores and indexes that version shipped with, never a shape it never
 * had — populated with representative rows, then opened by the production
 * `database()` helpers and checked for lossless upgrade, index reachability,
 * idempotency, and safety after an interrupted upgrade.
 *
 * ADDING A VERSION: append one entry to `OFFLINE_HISTORY` (or `SYNC_HISTORY`)
 * and, if the new version adds a store or index, one entry to the matching
 * `CURRENT_*_SCHEMA`. The `covers every shipped schema version` guard fails
 * until you do.
 */

const OFFLINE_DATABASE = "chapterline-offline-v1";
const SYNC_DATABASE = "chapterline-sync-v1";
const USER_A = "user-a";
const USER_B = "user-b";
const INTERRUPTED_KEY = "interrupted-upgrade-row";

// ---------------------------------------------------------------------------
// Raw fixture plumbing (no production code — this is what the browser had)
// ---------------------------------------------------------------------------

type IndexShape = Record<string, string | string[]>;
type StoreShape = { keyPath: string; indexes: IndexShape };
type SchemaShape = Record<string, StoreShape>;

type LegacyVersion = {
  version: number;
  /** Stores/indexes exactly as this version created them. */
  schema: SchemaShape;
  /** Representative rows this version could legitimately hold. */
  rows: Record<string, Record<string, unknown>[]>;
};

const BY_USER: IndexShape = { "by-user": "userId" };
const BY_USER_BOOK: IndexShape = { "by-user-book": ["userId", "bookId"] };

function buildFixture(name: string, fixture: LegacyVersion): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, fixture.version);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const [store, shape] of Object.entries(fixture.schema)) {
        const objectStore = db.createObjectStore(store, { keyPath: shape.keyPath });
        for (const [index, keyPath] of Object.entries(shape.indexes)) {
          objectStore.createIndex(index, keyPath);
        }
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const stores = Object.keys(fixture.rows).filter((store) => fixture.rows[store]!.length);
      if (!stores.length) {
        db.close();
        resolve();
        return;
      }
      const transaction = db.transaction(stores, "readwrite");
      for (const store of stores) {
        for (const row of fixture.rows[store]!) transaction.objectStore(store).put(row);
      }
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("fixture write aborted"));
    };
  });
}

/**
 * Runs a version-change transaction that does part of the work and then dies,
 * standing in for a tab that is killed (or a device that sleeps) mid-upgrade.
 */
function interruptUpgrade(name: string, version: number, schema: SchemaShape): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      const transaction = request.transaction!;
      for (const [store, shape] of Object.entries(schema)) {
        const objectStore = db.objectStoreNames.contains(store)
          ? transaction.objectStore(store)
          : db.createObjectStore(store, { keyPath: shape.keyPath });
        for (const [index, keyPath] of Object.entries(shape.indexes)) {
          if (!objectStore.indexNames.contains(index)) objectStore.createIndex(index, keyPath);
        }
        objectStore.put({
          [shape.keyPath]: INTERRUPTED_KEY,
          userId: USER_A,
          value: -1,
          halfWritten: true,
        });
      }
      transaction.abort();
    };
    // An aborted version-change transaction surfaces as an open error.
    request.onerror = () => resolve();
    request.onblocked = () => reject(new Error(`interrupted upgrade of ${name} was blocked`));
    request.onsuccess = () => {
      request.result.close();
      reject(new Error(`interrupted upgrade of ${name} unexpectedly committed`));
    };
  });
}

function currentVersion(name: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const version = request.result.version;
      request.result.close();
      resolve(version);
    };
  });
}

async function snapshot(db: IDBPDatabase): Promise<Record<string, unknown[]>> {
  const rows: Record<string, unknown[]> = {};
  for (const store of [...db.objectStoreNames].sort()) {
    rows[store] = await db.getAll(store);
  }
  return rows;
}

async function assertSchema(db: IDBPDatabase, schema: SchemaShape) {
  expect([...db.objectStoreNames].sort()).toStrictEqual(Object.keys(schema).sort());
  const transaction = db.transaction([...db.objectStoreNames], "readonly");
  for (const [name, shape] of Object.entries(schema)) {
    const store = transaction.objectStore(name);
    expect(store.keyPath, `${name} keyPath`).toBe(shape.keyPath);
    expect([...store.indexNames].sort(), `${name} indexes`).toStrictEqual(
      Object.keys(shape.indexes).sort(),
    );
    for (const [index, keyPath] of Object.entries(shape.indexes)) {
      const handle = store.index(index);
      expect(handle.keyPath, `${name}.${index} keyPath`).toStrictEqual(keyPath);
      expect(handle.unique, `${name}.${index} unique`).toBe(false);
      expect(handle.multiEntry, `${name}.${index} multiEntry`).toBe(false);
    }
  }
  await transaction.done;
}

/** Every row must be reachable by primary key AND through each index. */
async function assertReachable(
  db: IDBPDatabase,
  schema: SchemaShape,
  expected: Record<string, Record<string, unknown>[]>,
) {
  for (const [store, shape] of Object.entries(schema)) {
    const rows = expected[store] ?? [];
    expect(await db.count(store), `${store} row count`).toBe(rows.length);
    for (const row of rows) {
      const key = row[shape.keyPath] as string;
      expect(await db.get(store, key), `${store}[${key}] by primary key`).toStrictEqual(row);
    }
    for (const [index, keyPath] of Object.entries(shape.indexes)) {
      const paths = Array.isArray(keyPath) ? keyPath : [keyPath];
      const seen = new Set<string>();
      for (const row of rows) {
        const indexKey = paths.map((path) => row[path] as IDBValidKey);
        const lookup: IDBValidKey = paths.length === 1 ? indexKey[0]! : indexKey;
        if (seen.has(JSON.stringify(lookup))) continue;
        seen.add(JSON.stringify(lookup));
        const found = await db.getAllFromIndex(store, index, lookup);
        expect(found, `${store}.${index} -> ${JSON.stringify(lookup)}`).toStrictEqual(
          rows
            .filter((candidate) =>
              paths.every((path, position) => candidate[path] === indexKey[position]),
            )
            // Index reads come back in primary-key order within an index key.
            .sort((left, right) =>
              String(left[shape.keyPath]).localeCompare(String(right[shape.keyPath])),
            ),
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// chapterline-offline-v1 history
// ---------------------------------------------------------------------------

const OFFLINE_STORE = {
  downloads: { keyPath: "key", indexes: BY_USER } satisfies StoreShape,
  deletions: { keyPath: "key", indexes: BY_USER } satisfies StoreShape,
  cacheEntries: { keyPath: "url", indexes: BY_USER } satisfies StoreShape,
  transcripts: { keyPath: "key", indexes: BY_USER } satisfies StoreShape,
  // The version-7 mirror. Every store leads with `userId` so an account purge
  // is a bounded key range rather than a scan.
  books: {
    keyPath: "key",
    indexes: { "by-user": "userId", "by-user-updated": ["userId", "updatedAt"] },
  } satisfies StoreShape,
  chapters: { keyPath: "key", indexes: BY_USER_BOOK } satisfies StoreShape,
  playbackStates: { keyPath: "key", indexes: BY_USER } satisfies StoreShape,
  tags: { keyPath: "key", indexes: BY_USER } satisfies StoreShape,
  bookTags: {
    keyPath: "key",
    indexes: { ...BY_USER, ...BY_USER_BOOK },
  } satisfies StoreShape,
  collections: { keyPath: "key", indexes: BY_USER } satisfies StoreShape,
  collectionBooks: {
    keyPath: "key",
    indexes: { "by-user": "userId", "by-user-collection": ["userId", "collectionId"] },
  } satisfies StoreShape,
  preferences: { keyPath: "userId", indexes: {} } satisfies StoreShape,
  listeningSessions: { keyPath: "key", indexes: BY_USER_BOOK } satisfies StoreShape,
  syncMeta: { keyPath: "userId", indexes: {} } satisfies StoreShape,
};

/** Stores added by version 7; every earlier fixture must gain them empty. */
const MIRROR_STORE_NAMES = [
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
] as const;

const CURRENT_OFFLINE_SCHEMA: SchemaShape = {
  downloads: OFFLINE_STORE.downloads,
  deletions: OFFLINE_STORE.deletions,
  cacheEntries: OFFLINE_STORE.cacheEntries,
  transcripts: OFFLINE_STORE.transcripts,
  ...Object.fromEntries(MIRROR_STORE_NAMES.map((name) => [name, OFFLINE_STORE[name]])),
};

function playerBook(id: string) {
  return {
    id,
    title: `Title ${id}`,
    author: "Author",
    durationMs: 3_600_000,
    chapters: [
      { id: `${id}:0`, position: 0, title: "Opening", startMs: 0, endMs: 1_800_000 },
      { id: `${id}:1`, position: 1, title: "Closing", startMs: 1_800_000, endMs: 3_600_000 },
    ],
    initialPositionMs: 12_345,
    initialProgressOccurredAt: "2026-07-01T00:00:00.000Z",
    initialPlaybackRate: 1.25,
    completed: false,
  };
}

/**
 * Cover thumbnails only exist from v5 onward (added while the schema sat at
 * version 5); legacy `bookmarks` projections only exist before v5, which is
 * where the cursor sweep strips them.
 */
function offlineDownloads(version: number): Record<string, unknown>[] {
  const legacy = version < 5;
  const thumbs = version >= 5;
  const plain: Record<string, unknown> = {
    key: `${USER_A}:book-plain`,
    userId: USER_A,
    book: playerBook("book-plain"),
    offlineMediaUrl: "/offline-media/plain",
    offlineCoverUrl: null,
    byteSize: 4_194_311,
    downloadedAt: "2026-07-02T00:00:00.000Z",
  };
  const covered: Record<string, unknown> = {
    key: `${USER_A}:book-covered`,
    userId: USER_A,
    book: playerBook("book-covered"),
    offlineMediaUrl: "/offline-media/covered",
    offlineCoverUrl: "/offline-media/covered-cover",
    byteSize: 9_000_000,
    downloadedAt: "2026-07-03T00:00:00.000Z",
  };
  const other: Record<string, unknown> = {
    key: `${USER_B}:book-other`,
    userId: USER_B,
    book: playerBook("book-other"),
    offlineMediaUrl: "/offline-media/other",
    offlineCoverUrl: "/offline-media/other-cover",
    byteSize: 512,
    downloadedAt: "2026-07-04T00:00:00.000Z",
  };
  if (thumbs) {
    covered.offlineCoverThumbUrl = "/offline-media/covered-thumb";
    other.offlineCoverThumbUrl = null;
  }
  if (legacy) {
    plain.bookmarks = [{ id: "legacy-1", positionMs: 10, note: "gone" }];
    covered.bookmarks = [];
    // `other` keeps no bookmarks key: mixed shapes must both survive.
  }
  return [plain, covered, other];
}

function offlineDeletions(version: number): Record<string, unknown>[] {
  const pending: Record<string, unknown> = {
    key: `${USER_A}:book-deleting`,
    userId: USER_A,
    bookId: "book-deleting",
    offlineMediaUrl: "/offline-media/deleting",
    offlineCoverUrl: "/offline-media/deleting-cover",
  };
  if (version >= 5) pending.offlineCoverThumbUrl = "/offline-media/deleting-thumb";
  return [
    pending,
    {
      key: `${USER_B}:book-done`,
      userId: USER_B,
      bookId: "book-done",
      completedAt: 1_770_000_000_000,
    },
  ];
}

function offlineCacheEntries(): Record<string, unknown>[] {
  return [
    { url: "/offline-media/covered", userId: USER_A, bookId: "book-covered" },
    { url: "/offline-media/covered-cover", userId: USER_A, bookId: "book-covered" },
    { url: "/offline-media/covered/chunk/0", userId: USER_A, bookId: "book-covered" },
    { url: "/offline-media/covered/chunk/1", userId: USER_A, bookId: "book-covered" },
    { url: "/offline-media/other", userId: USER_B, bookId: "book-other" },
  ];
}

function transcriptKey(userId: string, bookId: string, chapterIndex: number) {
  return `${userId}:${bookId}:${String(chapterIndex).padStart(6, "0")}`;
}

function offlineTranscripts(): Record<string, unknown>[] {
  return [
    {
      key: transcriptKey(USER_A, "book-covered", 0),
      userId: USER_A,
      bookId: "book-covered",
      chapterIndex: 0,
      granularity: "word",
      sentences: [
        {
          text: "Call me Ishmael.",
          startMs: 0,
          endMs: 1_500,
          words: [
            { text: "Call", startMs: 0, endMs: 400, charStart: 0, charEnd: 4 },
            { text: "me", startMs: 400, endMs: 700, charStart: 5, charEnd: 7 },
            { text: "Ishmael", startMs: 700, endMs: 1_500, charStart: 8, charEnd: 15 },
          ],
        },
      ],
    },
    {
      key: transcriptKey(USER_A, "book-covered", 1),
      userId: USER_A,
      bookId: "book-covered",
      chapterIndex: 1,
      granularity: "sentence",
      sentences: [{ text: "Some years ago.", startMs: 0, endMs: 2_000, words: [] }],
    },
    {
      key: transcriptKey(USER_B, "book-other", 12),
      userId: USER_B,
      bookId: "book-other",
      chapterIndex: 12,
      granularity: "sentence",
      sentences: [{ text: "Never mind how long.", startMs: 10, endMs: 900, words: [] }],
    },
  ];
}

/**
 * Version-7 mirror rows: a two-account device holding a full book aggregate
 * (metadata, embedded media, chapters, tag edges), progress, a collection with
 * membership, preferences, a listening session and a pull cursor. Audio bytes
 * and transcript cues are deliberately absent — the mirror never holds either.
 */
function mirrorRows(): Record<string, Record<string, unknown>[]> {
  const searchText = (title: string, author: string, narrator = "", series = "") =>
    [title, author, narrator, series].join(" ").toLowerCase();
  return {
    books: [
      {
        key: `${USER_A}:book-covered`,
        userId: USER_A,
        bookId: "book-covered",
        title: "Title book-covered",
        author: "Author",
        narrator: "Narrator",
        description: "A mirrored description.",
        series: "Series One",
        seriesPosition: "2.00",
        chapterDiagnostic: null,
        archivedAt: null,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-07-03T00:00:00.000Z",
        media: {
          originalFilename: "covered.mp3",
          mimeType: "audio/mpeg",
          byteSize: 9_000_000,
          fingerprint: "c".repeat(64),
          fingerprintKind: "sha256-v1",
          durationMs: 3_600_000,
        },
        searchText: searchText("Title book-covered", "Author", "Narrator", "Series One"),
      },
      {
        key: `${USER_A}:book-archived`,
        userId: USER_A,
        bookId: "book-archived",
        title: "Title book-archived",
        author: "Author",
        narrator: null,
        description: null,
        series: null,
        seriesPosition: null,
        chapterDiagnostic: "Chapters recovered from an overflowed tag.",
        archivedAt: "2026-07-01T00:00:00.000Z",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        media: null,
        searchText: searchText("Title book-archived", "Author"),
      },
      {
        key: `${USER_B}:book-other`,
        userId: USER_B,
        bookId: "book-other",
        title: "Title book-other",
        author: "Other Author",
        narrator: null,
        description: null,
        series: null,
        seriesPosition: null,
        chapterDiagnostic: null,
        archivedAt: null,
        createdAt: "2026-06-02T00:00:00.000Z",
        updatedAt: "2026-07-04T00:00:00.000Z",
        media: null,
        searchText: searchText("Title book-other", "Other Author"),
      },
    ],
    chapters: [
      {
        key: `${USER_A}:book-covered:000000`,
        userId: USER_A,
        bookId: "book-covered",
        position: 0,
        title: "Opening",
        startMs: 0,
        endMs: 1_800_000,
      },
      {
        key: `${USER_A}:book-covered:000001`,
        userId: USER_A,
        bookId: "book-covered",
        position: 1,
        title: "Closing",
        startMs: 1_800_000,
        endMs: 3_600_000,
      },
      {
        key: `${USER_B}:book-other:000000`,
        userId: USER_B,
        bookId: "book-other",
        position: 0,
        title: "Only chapter",
        startMs: 0,
        endMs: 600_000,
      },
    ],
    playbackStates: [
      {
        key: `${USER_A}:book-covered`,
        userId: USER_A,
        bookId: "book-covered",
        positionMs: 12_345,
        playbackRate: 1.25,
        completed: false,
        deviceId: "device-1",
        deviceSequence: 41,
        eventOccurredAt: "2026-07-05T00:00:00.000Z",
        updatedAt: "2026-07-05T00:00:01.000Z",
      },
      {
        key: `${USER_B}:book-other`,
        userId: USER_B,
        bookId: "book-other",
        positionMs: 0,
        playbackRate: 1,
        completed: true,
        deviceId: "device-2",
        deviceSequence: 7,
        eventOccurredAt: "2026-07-06T00:00:00.000Z",
        updatedAt: "2026-07-06T00:00:01.000Z",
      },
    ],
    tags: [
      { key: `${USER_A}:tag-fiction`, userId: USER_A, tagId: "tag-fiction", name: "Fiction" },
      { key: `${USER_A}:tag-classics`, userId: USER_A, tagId: "tag-classics", name: "Classics" },
      { key: `${USER_B}:tag-owned`, userId: USER_B, tagId: "tag-owned", name: "Owned" },
    ],
    bookTags: [
      {
        key: `${USER_A}:book-covered:tag-fiction`,
        userId: USER_A,
        bookId: "book-covered",
        tagId: "tag-fiction",
      },
      {
        key: `${USER_A}:book-covered:tag-classics`,
        userId: USER_A,
        bookId: "book-covered",
        tagId: "tag-classics",
      },
      {
        key: `${USER_B}:book-other:tag-owned`,
        userId: USER_B,
        bookId: "book-other",
        tagId: "tag-owned",
      },
    ],
    collections: [
      {
        key: `${USER_A}:collection-queue`,
        userId: USER_A,
        collectionId: "collection-queue",
        name: "Queue",
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
    ],
    collectionBooks: [
      {
        key: `${USER_A}:collection-queue:book-covered`,
        userId: USER_A,
        collectionId: "collection-queue",
        bookId: "book-covered",
        position: 0,
      },
      {
        key: `${USER_A}:collection-queue:book-archived`,
        userId: USER_A,
        collectionId: "collection-queue",
        bookId: "book-archived",
        position: 1,
      },
    ],
    preferences: [
      {
        userId: USER_A,
        skipBackMs: 15_000,
        skipForwardMs: 30_000,
        smartRewind: true,
        autoplayNextInCollection: false,
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ],
    listeningSessions: [
      {
        key: `${USER_A}:session-1`,
        userId: USER_A,
        sessionId: "session-1",
        bookId: "book-covered",
        startedAt: "2026-07-05T00:00:00.000Z",
        endedAt: "2026-07-05T00:30:00.000Z",
        startPositionMs: 0,
        endPositionMs: 1_800_000,
        listenedMs: 1_800_000,
      },
      {
        key: `${USER_B}:session-2`,
        userId: USER_B,
        sessionId: "session-2",
        bookId: "book-other",
        startedAt: "2026-07-06T00:00:00.000Z",
        endedAt: "2026-07-06T00:10:00.000Z",
        startPositionMs: 0,
        endPositionMs: 600_000,
        listenedMs: 600_000,
      },
    ],
    syncMeta: [
      {
        userId: USER_A,
        cursor: "2026-07-05T00:00:01.000Z",
        lastSyncedAt: "2026-07-05T00:05:00.000Z",
      },
      {
        userId: USER_B,
        cursor: "2026-07-06T00:00:01.000Z",
        lastSyncedAt: "2026-07-06T00:05:00.000Z",
      },
    ],
  };
}

function offlineFixture(version: number): LegacyVersion {
  const schema: SchemaShape = { downloads: OFFLINE_STORE.downloads };
  const rows: Record<string, Record<string, unknown>[]> = { downloads: offlineDownloads(version) };
  if (version >= 2) {
    schema.deletions = OFFLINE_STORE.deletions;
    rows.deletions = offlineDeletions(version);
  }
  if (version >= 4) {
    schema.cacheEntries = OFFLINE_STORE.cacheEntries;
    rows.cacheEntries = offlineCacheEntries();
  }
  if (version >= 6) {
    schema.transcripts = OFFLINE_STORE.transcripts;
    rows.transcripts = offlineTranscripts();
  }
  if (version >= 7) {
    const mirror = mirrorRows();
    for (const store of MIRROR_STORE_NAMES) {
      schema[store] = OFFLINE_STORE[store];
      rows[store] = mirror[store]!;
    }
  }
  return { version, schema, rows };
}

/** Post-upgrade expectation: identical rows minus the stripped legacy field. */
function expectedOffline(fixture: LegacyVersion): Record<string, Record<string, unknown>[]> {
  const expected: Record<string, Record<string, unknown>[]> = {};
  for (const store of Object.keys(CURRENT_OFFLINE_SCHEMA)) {
    expected[store] = (fixture.rows[store] ?? []).map((row) => {
      if (store !== "downloads") return row;
      const clean = { ...row };
      delete clean.bookmarks;
      return clean;
    });
  }
  return expected;
}

// Versions 1..7 as db.ts's upgrade path defines them. v3 never differed from
// v2 (the `oldVersion < 4` branch creates cacheEntries for both).
const OFFLINE_HISTORY: LegacyVersion[] = [1, 2, 3, 4, 5, 6, 7].map(offlineFixture);

// ---------------------------------------------------------------------------
// chapterline-sync-v1 history
// ---------------------------------------------------------------------------

const CURRENT_SYNC_SCHEMA: SchemaShape = {
  mutations: { keyPath: "key", indexes: { "by-user": "userId", "by-user-key": ["userId", "key"] } },
  sequences: { keyPath: "key", indexes: {} },
};

function progressMutation(userId: string, bookId: string, deviceSequence: number) {
  return {
    key: `${userId}:progress:${bookId}:device-1`,
    userId,
    kind: "progress",
    entry: {
      userId,
      bookId,
      deviceId: "device-1",
      deviceSequence,
      positionMs: deviceSequence * 1_000,
      playbackRate: 1,
      completed: false,
      eventOccurredAt: "2026-07-05T00:00:00.000Z",
    },
  };
}

const SURVIVING_MUTATIONS = [
  progressMutation(USER_A, "book-plain", 3),
  progressMutation(USER_A, "book-covered", 41),
  progressMutation(USER_B, "book-other", 7),
];

/**
 * Device-sequence high-water marks. Losing or resetting a row here silently
 * reorders or discards replayed progress writes, so they are asserted by
 * exact value.
 */
const SEQUENCE_ROWS = [
  { key: "book-plain", value: 3 },
  { key: "book-covered", value: 41 },
  { key: "book-other", value: 7 },
  { key: "book-never-replayed", value: 999_999 },
];

function syncFixture(version: number): LegacyVersion {
  // v1 and v2 shipped with `by-user` only; `by-user-key` arrives in v3.
  const mutations: StoreShape = {
    keyPath: "key",
    indexes: version >= 3 ? CURRENT_SYNC_SCHEMA.mutations!.indexes : BY_USER,
  };
  const mutationRows: Record<string, unknown>[] = [...SURVIVING_MUTATIONS];
  const rows: Record<string, Record<string, unknown>[]> = {
    mutations: mutationRows,
    sequences: [...SEQUENCE_ROWS],
  };
  // Non-progress kinds could only exist before the v2 purge.
  if (version < 2) {
    mutationRows.push(
      {
        key: `${USER_A}:bookmark:legacy-1`,
        userId: USER_A,
        kind: "bookmark",
        entry: { userId: USER_A, bookId: "book-plain", clientId: "legacy-1", positionMs: 5 },
      },
      {
        key: `${USER_B}:bookmark-delete:legacy-2`,
        userId: USER_B,
        kind: "bookmark-delete",
        entry: { userId: USER_B, bookId: "book-other", bookmarkId: "legacy-2" },
      },
    );
  }
  return {
    version,
    schema: { mutations, sequences: { keyPath: "key", indexes: {} } },
    rows,
  };
}

function expectedSync(): Record<string, Record<string, unknown>[]> {
  return { mutations: [...SURVIVING_MUTATIONS], sequences: [...SEQUENCE_ROWS] };
}

const SYNC_HISTORY: LegacyVersion[] = [1, 2, 3].map(syncFixture);

// ---------------------------------------------------------------------------
// Production open helpers (the code under test)
// ---------------------------------------------------------------------------

async function upgradeOffline(): Promise<IDBPDatabase> {
  const db = await openOfflineDatabase();
  db.close();
  return await openDB(OFFLINE_DATABASE);
}

async function upgradeSync(): Promise<IDBPDatabase> {
  // `currentDeviceSequence` is the cheapest read-only entry point into the
  // sync module's own `database()`, so the real upgrade path runs.
  const { currentDeviceSequence } = await import("../offline-sync");
  await currentDeviceSequence("migration-probe");
  return await openDB(SYNC_DATABASE);
}

const TARGETS = {
  offline: {
    name: OFFLINE_DATABASE,
    schema: CURRENT_OFFLINE_SCHEMA,
    history: OFFLINE_HISTORY,
    open: upgradeOffline,
    expected: expectedOffline,
  },
  sync: {
    name: SYNC_DATABASE,
    schema: CURRENT_SYNC_SCHEMA,
    history: SYNC_HISTORY,
    open: upgradeSync,
    expected: expectedSync,
  },
} as const;

beforeEach(() => {
  // A brand new in-memory factory per test: no stale connections, no blocked
  // deletes, no ordering coupling between cases.
  vi.stubGlobal("indexedDB", new FakeIDBFactory());
});

describe.each(Object.entries(TARGETS))("%s database migrations", (_label, target) => {
  it("covers every shipped schema version with a fixture", async () => {
    const version = await target.open().then((db) => {
      const value = db.version;
      db.close();
      return value;
    });
    expect(
      target.history.map((fixture) => fixture.version),
      `add a fixture for ${target.name} v${version}`,
    ).toStrictEqual(Array.from({ length: version }, (_unused, index) => index + 1));
  });

  it("creates the current schema from empty", async () => {
    const db = await target.open();
    await assertSchema(db, target.schema);
    db.close();
  });

  describe.each(target.history)("from version $version", (fixture) => {
    it("upgrades losslessly with every row reachable by key and index", async () => {
      await buildFixture(target.name, fixture);

      const db = await target.open();

      expect(db.version).toBe(target.history.at(-1)!.version);
      await assertSchema(db, target.schema);
      await assertReachable(db, target.schema, target.expected(fixture));
      db.close();
    });

    it("is idempotent when reopened at the current version", async () => {
      await buildFixture(target.name, fixture);
      const first = await target.open();
      const before = await snapshot(first);
      first.close();

      const second = await target.open();
      const after = await snapshot(second);
      second.close();

      const upgrade = vi.fn();
      const probe = await openDB(target.name, target.history.at(-1)!.version, { upgrade });
      const third = await snapshot(probe);
      probe.close();

      expect(upgrade).not.toHaveBeenCalled();
      expect(after).toStrictEqual(before);
      expect(third).toStrictEqual(before);
    });

    it("recovers from an upgrade interrupted midway without loss or duplicates", async () => {
      await buildFixture(target.name, fixture);

      // A version-change transaction that half-builds the new schema and then
      // dies must roll all the way back. A fixture already at the current
      // version is interrupted one version ahead, so the abort path is still
      // exercised for it.
      const latest = target.history.at(-1)!.version;
      await interruptUpgrade(target.name, Math.max(latest, fixture.version + 1), target.schema);
      expect(await currentVersion(target.name)).toBe(fixture.version);

      const db = await target.open();

      await assertSchema(db, target.schema);
      await assertReachable(db, target.schema, target.expected(fixture));
      for (const store of Object.keys(target.schema)) {
        expect(await db.get(store, INTERRUPTED_KEY), `${store} half-written row`).toBe(undefined);
      }
      db.close();
    });
  });
});

describe("chapterline-offline-v1 upgrade specifics", () => {
  it.each(OFFLINE_HISTORY.filter((fixture) => fixture.version < 5))(
    "strips legacy bookmark projections stored at version $version",
    async (fixture) => {
      await buildFixture(OFFLINE_DATABASE, fixture);
      expect(
        (fixture.rows.downloads ?? []).some((row) => "bookmarks" in row),
        "fixture must actually carry legacy bookmarks",
      ).toBe(true);

      const db = await upgradeOffline();

      const downloads = await db.getAll("downloads");
      expect(downloads).toHaveLength(3);
      for (const record of downloads as Record<string, unknown>[]) {
        expect(record).not.toHaveProperty("bookmarks");
      }
      // The sweep must not damage anything else on the record.
      expect(await db.get("downloads", `${USER_A}:book-plain`)).toStrictEqual(
        expectedOffline(fixture).downloads!.find((row) => row.key === `${USER_A}:book-plain`),
      );
      db.close();
    },
  );

  it("keeps a thumbnail-less record thumbnail-less instead of inventing a field", async () => {
    await buildFixture(OFFLINE_DATABASE, offlineFixture(1));

    const db = await upgradeOffline();

    const record = (await db.get("downloads", `${USER_A}:book-plain`)) as Record<string, unknown>;
    expect(record).not.toHaveProperty("offlineCoverThumbUrl");
    expect(record.offlineCoverUrl).toBe(null);
    db.close();
  });

  it("preserves both thumbnail shapes stored at version 5", async () => {
    await buildFixture(OFFLINE_DATABASE, offlineFixture(5));

    const db = await upgradeOffline();

    expect(
      ((await db.get("downloads", `${USER_A}:book-covered`)) as Record<string, unknown>)
        .offlineCoverThumbUrl,
    ).toBe("/offline-media/covered-thumb");
    expect(
      ((await db.get("downloads", `${USER_B}:book-other`)) as Record<string, unknown>)
        .offlineCoverThumbUrl,
    ).toBe(null);
    db.close();
  });

  it("keeps an in-flight deletion journal entry pending across the upgrade", async () => {
    await buildFixture(OFFLINE_DATABASE, offlineFixture(2));

    const db = await upgradeOffline();

    const pending = (await db.get("deletions", `${USER_A}:book-deleting`)) as Record<
      string,
      unknown
    >;
    expect(pending).not.toHaveProperty("completedAt");
    expect(pending.offlineMediaUrl).toBe("/offline-media/deleting");
    db.close();
  });

  it("adds an empty transcripts store to pre-v6 databases", async () => {
    await buildFixture(OFFLINE_DATABASE, offlineFixture(5));

    const db = await upgradeOffline();

    expect([...db.objectStoreNames]).toContain("transcripts");
    expect(await db.getAll("transcripts")).toStrictEqual([]);
    db.close();
  });

  it.each(OFFLINE_HISTORY.filter((fixture) => fixture.version < 7))(
    "adds the mirror empty to a version $version database without touching its data",
    async (fixture) => {
      await buildFixture(OFFLINE_DATABASE, fixture);

      const db = await upgradeOffline();

      expect(db.version).toBe(7);
      for (const store of MIRROR_STORE_NAMES) {
        expect([...db.objectStoreNames], `${store} created`).toContain(store);
        expect(await db.getAll(store), `${store} starts empty`).toStrictEqual([]);
      }
      // The pre-existing stores keep every row, byte for byte, apart from the
      // legacy bookmark strip the v5 sweep already owned.
      const expected = expectedOffline(fixture);
      for (const store of ["downloads", "deletions", "cacheEntries", "transcripts"] as const) {
        const shape = CURRENT_OFFLINE_SCHEMA[store]!;
        const rows = expected[store] ?? [];
        expect(await db.count(store), `${store} row count`).toBe(rows.length);
        for (const row of rows) {
          const key = row[shape.keyPath] as string;
          expect(await db.get(store, key), `${store}[${key}]`).toStrictEqual(row);
        }
      }
      db.close();
    },
  );

  it("keeps every mirrored row reachable by key and by index at version 7", async () => {
    await buildFixture(OFFLINE_DATABASE, offlineFixture(7));

    const db = await upgradeOffline();

    // One representative lookup per mirror index, so a swapped or missing
    // keyPath fails here rather than silently returning nothing at runtime.
    expect(
      (await db.getAllFromIndex("books", "by-user", USER_A)).map((row) => row.bookId),
    ).toStrictEqual(["book-archived", "book-covered"]);
    expect(
      (
        await db.getAllFromIndex("books", "by-user-updated", [USER_A, "2026-07-03T00:00:00.000Z"])
      ).map((row) => row.bookId),
    ).toStrictEqual(["book-covered"]);
    expect(
      (await db.getAllFromIndex("chapters", "by-user-book", [USER_A, "book-covered"])).map(
        (row) => row.position,
      ),
    ).toStrictEqual([0, 1]);
    expect(await db.getAllFromIndex("playbackStates", "by-user", USER_B)).toHaveLength(1);
    expect(
      (await db.getAllFromIndex("tags", "by-user", USER_A)).map((row) => row.name).sort(),
    ).toStrictEqual(["Classics", "Fiction"]);
    expect(
      await db.getAllFromIndex("bookTags", "by-user-book", [USER_A, "book-covered"]),
    ).toHaveLength(2);
    expect(await db.getAllFromIndex("collections", "by-user", USER_A)).toHaveLength(1);
    expect(
      (
        await db.getAllFromIndex("collectionBooks", "by-user-collection", [
          USER_A,
          "collection-queue",
        ])
      ).map((row) => row.bookId),
    ).toStrictEqual(["book-archived", "book-covered"]);
    expect(
      await db.getAllFromIndex("listeningSessions", "by-user-book", [USER_A, "book-covered"]),
    ).toHaveLength(1);
    expect((await db.get("preferences", USER_A))?.skipForwardMs).toBe(30_000);
    expect((await db.get("syncMeta", USER_A))?.cursor).toBe("2026-07-05T00:00:01.000Z");
    db.close();
  });

  it("survives a stepwise upgrade that stops at an intermediate shipped version", async () => {
    await buildFixture(OFFLINE_DATABASE, offlineFixture(1));

    // The user ran an older build that only knew about version 4 before
    // updating to the current one.
    const intermediate = await openDB(OFFLINE_DATABASE, 4, {
      upgrade(db, oldVersion) {
        if (oldVersion < 2) {
          db.createObjectStore("deletions", { keyPath: "key" }).createIndex("by-user", "userId");
        }
        if (oldVersion < 4) {
          db.createObjectStore("cacheEntries", { keyPath: "url" }).createIndex("by-user", "userId");
        }
      },
    });
    intermediate.close();

    const db = await upgradeOffline();

    await assertSchema(db, CURRENT_OFFLINE_SCHEMA);
    const downloads = (await db.getAll("downloads")) as Record<string, unknown>[];
    expect(downloads).toHaveLength(3);
    for (const record of downloads) expect(record).not.toHaveProperty("bookmarks");
    db.close();
  });
});

describe("chapterline-sync-v1 upgrade specifics", () => {
  it("purges legacy non-progress mutations queued at version 1", async () => {
    const fixture = syncFixture(1);
    expect(
      fixture.rows.mutations!.filter((row) => row.kind !== "progress"),
      "fixture must actually carry legacy mutations",
    ).toHaveLength(2);
    await buildFixture(SYNC_DATABASE, fixture);

    const db = await upgradeSync();

    const mutations = (await db.getAll("mutations")) as Record<string, unknown>[];
    expect(mutations.map((row) => row.kind)).toStrictEqual(["progress", "progress", "progress"]);
    expect(mutations).toStrictEqual(
      [...SURVIVING_MUTATIONS].sort((left, right) => left.key.localeCompare(right.key)),
    );
    db.close();
  });

  it.each(SYNC_HISTORY)(
    "keeps device sequence high-water marks exact from version $version",
    async (fixture) => {
      await buildFixture(SYNC_DATABASE, fixture);

      const db = await upgradeSync();

      for (const row of SEQUENCE_ROWS) {
        expect(await db.get("sequences", row.key), `sequences[${row.key}]`).toStrictEqual(row);
      }
      // The probe read must not have invented or reset a row.
      expect(await db.count("sequences")).toBe(SEQUENCE_ROWS.length);
      db.close();
    },
  );

  it.each(SYNC_HISTORY)(
    "builds by-user-key over pre-existing mutations from version $version",
    async (fixture) => {
      await buildFixture(SYNC_DATABASE, fixture);

      const db = await upgradeSync();

      for (const mutation of SURVIVING_MUTATIONS) {
        expect(
          await db.getAllFromIndex("mutations", "by-user-key", [mutation.userId, mutation.key]),
          `by-user-key -> ${mutation.key}`,
        ).toStrictEqual([mutation]);
      }
      expect(await db.getAllFromIndex("mutations", "by-user", USER_A)).toHaveLength(2);
      expect(await db.getAllFromIndex("mutations", "by-user", USER_B)).toHaveLength(1);
      db.close();
    },
  );
});
