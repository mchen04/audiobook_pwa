import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";

import { ACTIVE_USER_KEY } from "@/lib/app-keys";
import { listQueuedMutations } from "@/lib/offline-sync";

import { listLocalUserIds, purgeAccount, purgeOnSignIn } from "./account-purge";
import { database, MEDIA_CACHE, mirrorKey } from "./db";
import { commitMetadataEdit } from "./outbox";

/**
 * Purge completeness — `docs/local-first.md` section 11.
 *
 * The assertion that matters is exhaustive rather than representative: after a
 * purge, *no* store may still hold a row for the departed account, and every
 * row belonging to the other account must be untouched. A store added later and
 * forgotten shows up here as a leaked row.
 */

const USER_A = "user-a";
const USER_B = "user-b";
const SHELL_CACHE = "chapterline-shell-v5";

type FakeCache = { store: Map<string, Response> };

function fakeCaches() {
  const caches = new Map<string, FakeCache>();
  const open = async (name: string) => {
    const cache = caches.get(name) || { store: new Map<string, Response>() };
    caches.set(name, cache);
    return {
      async put(request: Request | string, response: Response) {
        cache.store.set(typeof request === "string" ? request : request.url, response);
      },
      async match(request: Request | string) {
        return cache.store.get(typeof request === "string" ? request : request.url);
      },
      async delete(request: Request | string) {
        return cache.store.delete(typeof request === "string" ? request : request.url);
      },
      async keys() {
        return [...cache.store.keys()].map((url) => new Request(url));
      },
    };
  };
  return {
    api: { open, keys: async () => [...caches.keys()] },
    raw: caches,
  };
}

function fakeLocalStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    snapshot: () => [...map.keys()],
  };
}

let caches: ReturnType<typeof fakeCaches>;
let storage: ReturnType<typeof fakeLocalStorage>;

beforeEach(() => {
  vi.stubGlobal("indexedDB", new FakeIDBFactory());
  caches = fakeCaches();
  storage = fakeLocalStorage();
  vi.stubGlobal("caches", caches.api);
  vi.stubGlobal("localStorage", storage);
});

/** Every store that can hold user data, seeded for one account. */
async function seedAccount(userId: string) {
  const db = await database();
  const mediaUrl = `/offline-media/${userId}-book`;
  await db.put("downloads", {
    key: `${userId}:book`,
    userId,
    book: { id: "book", title: "T", author: "A", durationMs: 1, chapters: [] } as never,
    offlineMediaUrl: mediaUrl,
    offlineCoverUrl: null,
    byteSize: 1,
    downloadedAt: "2026-07-01T00:00:00.000Z",
  });
  await db.put("cacheEntries", { url: mediaUrl, userId, bookId: "book" });
  await db.put("cacheEntries", { url: `${mediaUrl}/chunk/0`, userId, bookId: "book" });
  // A completed deletion-journal row, exactly as `removeOfflineBook` leaves it:
  // it names the account and the books it deleted, and it outlives the download.
  await db.put("deletions", {
    key: `${userId}:removed-book`,
    userId,
    bookId: "removed-book",
    completedAt: 1_772_000_000_000,
  });
  await db.put("transcripts", {
    key: `${userId}:book:000000`,
    userId,
    bookId: "book",
    chapterIndex: 0,
    granularity: "sentence",
    sentences: [],
  });
  await db.put("books", {
    key: mirrorKey(userId, "book"),
    userId,
    bookId: "book",
    title: "T",
    author: "A",
    narrator: null,
    description: null,
    series: null,
    seriesPosition: null,
    chapterDiagnostic: null,
    archivedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    media: null,
    searchText: "t a  ",
  });
  await db.put("chapters", {
    key: `${userId}:book:000000`,
    userId,
    bookId: "book",
    position: 0,
    title: "One",
    startMs: 0,
    endMs: 1,
  });
  await db.put("playbackStates", {
    key: mirrorKey(userId, "book"),
    userId,
    bookId: "book",
    positionMs: 1,
    playbackRate: 1,
    completed: false,
    deviceId: "device-1",
    deviceSequence: 1,
    eventOccurredAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
  await db.put("tags", { key: mirrorKey(userId, "tag"), userId, tagId: "tag", name: "Tag" });
  await db.put("bookTags", {
    key: mirrorKey(userId, "book", "tag"),
    userId,
    bookId: "book",
    tagId: "tag",
  });
  await db.put("collections", {
    key: mirrorKey(userId, "collection"),
    userId,
    collectionId: "collection",
    name: "Queue",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
  await db.put("collectionBooks", {
    key: mirrorKey(userId, "collection", "book"),
    userId,
    collectionId: "collection",
    bookId: "book",
    position: 0,
  });
  await db.put("preferences", {
    userId,
    skipBackMs: 15_000,
    skipForwardMs: 30_000,
    smartRewind: true,
    autoplayNextInCollection: false,
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
  await db.put("listeningSessions", {
    key: mirrorKey(userId, "session"),
    userId,
    sessionId: "session",
    bookId: "book",
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T00:10:00.000Z",
    startPositionMs: 0,
    endPositionMs: 1,
    listenedMs: 1,
  });
  await db.put("syncMeta", {
    userId,
    cursor: "2026-07-01T00:00:00.000Z",
    lastSyncedAt: "2026-07-01T00:00:00.000Z",
  });

  await commitMetadataEdit({ userId, deviceId: "device-1" }, "book", { title: "Renamed" });

  const media = await caches.api.open(MEDIA_CACHE);
  await media.put(mediaUrl, new Response("audio"));
  await media.put(`${mediaUrl}/chunk/0`, new Response("chunk"));
  storage.setItem(`chapterline:position:${userId}`, "1");
}

/**
 * The stores `seedAccount` populates. This is a fixture manifest, not the list
 * the assertions iterate: `rowsFor` reads the *live* `objectStoreNames`, so a
 * store added to `db.ts` and forgotten by `purgeUser` leaks a row and fails —
 * and a store added but never seeded fails the guard below instead of silently
 * being excused. A hand-maintained list that the assertions also iterate would
 * make both of those invisible.
 */
const SEEDED_STORES = [
  "downloads",
  "cacheEntries",
  "deletions",
  "transcripts",
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

type LiveStore = (typeof SEEDED_STORES)[number];

/** The device's actual stores, not a list this file maintains in parallel. */
async function liveStores(): Promise<LiveStore[]> {
  const db = await database();
  return ([...db.objectStoreNames] as LiveStore[]).sort();
}

async function rowsFor(userId: string): Promise<Record<string, number>> {
  const db = await database();
  const counts: Record<string, number> = {};
  for (const store of await liveStores()) {
    const rows = (await db.getAll(store)) as { userId?: string }[];
    counts[store] = rows.filter((row) => row.userId === userId).length;
  }
  counts.outbox = (await listQueuedMutations(userId)).length;
  counts.localStorage = storage.snapshot().filter((key) => key.includes(`:${userId}`)).length;
  return counts;
}

describe("account purge", () => {
  it("seeds every store the device actually has", async () => {
    // If `db.ts` grows a store, this fails until the fixture covers it — which
    // is what keeps the sweep assertion below exhaustive instead of a sample.
    await seedAccount(USER_A);
    expect(await liveStores()).toStrictEqual([...SEEDED_STORES].sort());
    const seeded = await rowsFor(USER_A);
    for (const store of SEEDED_STORES) {
      expect(seeded[store], `${store} was not seeded`).toBeGreaterThan(0);
    }
  });

  it("leaves no row in any store for the purged account", async () => {
    await seedAccount(USER_A);
    await seedAccount(USER_B);
    storage.setItem(ACTIVE_USER_KEY, USER_A);
    const before = await rowsFor(USER_A);
    expect(
      Object.values(before).every((count) => count > 0),
      JSON.stringify(before),
    ).toBe(true);

    await purgeAccount(USER_A);

    const after = await rowsFor(USER_A);
    for (const [store, count] of Object.entries(after)) {
      expect(count, `${store} still holds rows for the purged account`).toBe(0);
    }
    expect(storage.getItem(ACTIVE_USER_KEY)).toBe(null);
  });

  it("leaves the other account entirely intact", async () => {
    await seedAccount(USER_A);
    await seedAccount(USER_B);
    const before = await rowsFor(USER_B);

    await purgeAccount(USER_A);

    expect(await rowsFor(USER_B)).toStrictEqual(before);
    expect(
      await (await caches.api.open(MEDIA_CACHE)).match(`/offline-media/${USER_B}-book`),
    ).toBeDefined();
  });

  it("removes the purged account's media bytes from Cache Storage", async () => {
    await seedAccount(USER_A);

    await purgeAccount(USER_A);

    const media = await caches.api.open(MEDIA_CACHE);
    expect(await media.match(`/offline-media/${USER_A}-book`)).toBeUndefined();
    expect(await media.match(`/offline-media/${USER_A}-book/chunk/0`)).toBeUndefined();
  });

  it("drops account-bearing page cache entries but keeps the user-agnostic shell", async () => {
    const shell = await caches.api.open(SHELL_CACHE);
    await shell.put("https://hark.test/offline", new Response("shell"));
    await shell.put("https://hark.test/_next/static/chunk.js", new Response("js"));
    await shell.put("https://hark.test/icons/icon-192.png", new Response("icon"));
    await shell.put("https://hark.test/library", new Response("account page"));
    await seedAccount(USER_A);

    await purgeAccount(USER_A);

    expect(await shell.match("https://hark.test/library")).toBeUndefined();
    expect(await shell.match("https://hark.test/offline")).toBeDefined();
    expect(await shell.match("https://hark.test/_next/static/chunk.js")).toBeDefined();
    expect(await shell.match("https://hark.test/icons/icon-192.png")).toBeDefined();
  });

  it("finds every account that has data on this device", async () => {
    await seedAccount(USER_A);
    await seedAccount(USER_B);

    expect((await listLocalUserIds()).sort()).toStrictEqual([USER_A, USER_B]);
  });

  it("purges the stale account on sign-in without touching the incoming one", async () => {
    await seedAccount(USER_A);
    await seedAccount(USER_B);
    storage.setItem(ACTIVE_USER_KEY, USER_A);
    const incoming = await rowsFor(USER_B);

    const purged = await purgeOnSignIn(USER_B);

    expect(purged).toStrictEqual([USER_A]);
    expect(Object.values(await rowsFor(USER_A)).every((count) => count === 0)).toBe(true);
    // The incoming account keeps its downloads: the MP3 exists nowhere else,
    // so signing in must never be what destroys the only copy.
    expect(await rowsFor(USER_B)).toStrictEqual(incoming);
  });

  it("is a no-op for the signing-in account when it is the only one present", async () => {
    await seedAccount(USER_A);
    const before = await rowsFor(USER_A);

    expect(await purgeOnSignIn(USER_A)).toStrictEqual([]);
    expect(await rowsFor(USER_A)).toStrictEqual(before);
  });
});

/**
 * The auth-client hook is the only wiring; every sign-in and sign-out goes
 * through it, so a component that forgets to purge cannot exist.
 */
describe("purge runs on both sign-out and sign-in", () => {
  async function fire(url: string, data?: unknown) {
    const { runAccountPurge } = await import("@/lib/auth-client");
    vi.stubGlobal("window", globalThis);
    await runAccountPurge({ request: { url }, data });
  }

  it("purges the departing account on sign-out", async () => {
    await seedAccount(USER_A);
    storage.setItem(ACTIVE_USER_KEY, USER_A);

    await fire("https://hark.test/api/auth/sign-out");

    expect(Object.values(await rowsFor(USER_A)).every((count) => count === 0)).toBe(true);
    expect(storage.getItem(ACTIVE_USER_KEY)).toBe(null);
  });

  it("purges a stale account on sign-in as somebody else", async () => {
    await seedAccount(USER_A);
    await seedAccount(USER_B);
    storage.setItem(ACTIVE_USER_KEY, USER_A);

    await fire("https://hark.test/api/auth/sign-in/email", { user: { id: USER_B } });

    expect(Object.values(await rowsFor(USER_A)).every((count) => count === 0)).toBe(true);
    expect(Object.values(await rowsFor(USER_B)).every((count) => count > 0)).toBe(true);
  });

  it("ignores auth traffic that is neither a sign-in nor a sign-out", async () => {
    await seedAccount(USER_A);
    const before = await rowsFor(USER_A);

    await fire("https://hark.test/api/auth/get-session", { user: { id: USER_B } });

    expect(await rowsFor(USER_A)).toStrictEqual(before);
  });
});
