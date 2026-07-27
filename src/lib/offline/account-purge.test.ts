import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";

import { ACTIVE_USER_KEY } from "@/lib/app-keys";
import { listQueuedMutations, nextDeviceSequence } from "@/lib/offline-sync";
import { listPendingPlaybackActions, storePlaybackAction } from "@/lib/playback-history";
import { openDB } from "idb";

import { listLocalUserIds, purgeAccount, purgeOnSignIn, purgeOnSignOut } from "./account-purge";
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
  // The answer this account gave to a recovery offer. It names the account and
  // one of its books, so it is residue in its own right — and the sweep below
  // finds it by key shape rather than by anything that knows it exists, which
  // is only worth relying on if the fixture actually contains one.
  storage.setItem(`chapterline:suspension-dismissed:${userId}:book`, "1700000000000");
  // A replay counter for this account, scoped `userId:bookId`.
  await nextDeviceSequence("book", userId);
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
  // The replay high-water marks live in the other database and are keyed
  // `userId:bookId`, so they are swept by key range rather than by index.
  const sync = await openDB("chapterline-sync-v1");
  counts.sequences = ((await sync.getAll("sequences")) as { key: string }[]).filter((row) =>
    row.key.startsWith(`${userId}:`),
  ).length;
  sync.close();
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
    // Both launch-shell keys are the SAME user-agnostic document the service
    // worker caches, so both survive — the cold launch's static route resolves
    // against this cache and a miss would go to the network. A page that really
    // does name an account still goes, which is what `/settings` proves.
    await shell.put("https://hark.test/library", new Response("shell"));
    await shell.put("https://hark.test/library?source=pwa", new Response("shell"));
    await shell.put("https://hark.test/settings", new Response("account page"));
    await seedAccount(USER_A);

    await purgeAccount(USER_A);

    expect(await shell.match("https://hark.test/settings")).toBeUndefined();
    expect(await shell.match("https://hark.test/library")).toBeDefined();
    expect(await shell.match("https://hark.test/library?source=pwa")).toBeDefined();
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

  /**
   * The production race, reproduced exactly.
   *
   * `@/lib/offline/account-purge` has no static importer, so in a built app the
   * `await import(...)` inside `runAccountPurge` is a chunk fetch — a real
   * asynchronous gap. `account-menu.tsx` used to clear `ACTIVE_USER_KEY` the
   * instant `signOut()` resolved, which is inside that gap. The purge then read
   * `null`, took the "nobody is signed in" branch, swept only the page cache,
   * and left the mirror, the downloads, the MP3s, the outbox, the playback
   * history and the deletion journal on the device.
   *
   * Here the gap is one microtask instead of one network round trip, which is
   * the SHORTEST it can ever be — a fix that survives this survives production.
   */
  it("captures the departing account before the caller can clear the key", async () => {
    const { runAccountPurge } = await import("@/lib/auth-client");
    vi.stubGlobal("window", globalThis);
    await seedAccount(USER_A);
    storage.setItem(ACTIVE_USER_KEY, USER_A);

    const purging = runAccountPurge({
      request: { url: "https://hark.test/api/auth/sign-out" },
    });
    // Precisely what the sign-out call site did the moment `signOut()` resolved.
    storage.removeItem(ACTIVE_USER_KEY);
    await purging;

    const after = await rowsFor(USER_A);
    for (const [store, count] of Object.entries(after)) {
      expect(count, `${store} survived a sign-out that raced the caller`).toBe(0);
    }
  });
});

/**
 * F11a — signing out must not be what destroys an unsent write.
 *
 * Every user write in this product is journaled to the outbox and lives nowhere
 * else until the server answers. `clearQueuedMutationsForUser` deletes that
 * queue, so sign-out was silently throwing away every edit a user made offline.
 */
describe("sign-out drains before it purges", () => {
  const ok = () => new Response(null, { status: 200 });

  it("delivers the account's unsent writes to the server before dropping them", async () => {
    await seedAccount(USER_A);
    storage.setItem(ACTIVE_USER_KEY, USER_A);
    expect((await listQueuedMutations(USER_A)).length).toBeGreaterThan(0);
    const sent: string[] = [];
    const fetchFn = (async (url: RequestInfo | URL) => {
      sent.push(String(url));
      return ok();
    }) as typeof fetch;

    const outcome = await purgeOnSignOut(USER_A, { fetchFn });

    expect(sent, "the queued metadata edit was never sent before the queue was cleared").toContain(
      "/api/books/book",
    );
    expect(outcome.undelivered).toStrictEqual([]);
    expect(outcome.failure).toBe(null);
    expect(await listQueuedMutations(USER_A)).toStrictEqual([]);
  });

  it("drains pending playback history too, which is its own outbox", async () => {
    const userId = "user-history-drain";
    const dead = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    await storePlaybackAction(userId, "book", playbackEntry("action-1"), dead);
    expect((await listPendingPlaybackActions(userId)).length).toBe(1);
    const sent: string[] = [];
    const fetchFn = (async (url: RequestInfo | URL) => {
      sent.push(String(url));
      return ok();
    }) as typeof fetch;

    const outcome = await purgeOnSignOut(userId, { fetchFn });

    expect(sent).toContain("/api/books/book/history");
    expect(outcome.undelivered).toStrictEqual([]);
  });

  it("reports writes the server would not take instead of dropping them silently", async () => {
    await seedAccount(USER_A);
    storage.setItem(ACTIVE_USER_KEY, USER_A);
    const fetchFn = (async () => new Response(null, { status: 503 })) as typeof fetch;

    const outcome = await purgeOnSignOut(USER_A, { fetchFn });

    expect(
      outcome.undelivered.map((write) => `${write.kind}:${write.entityId}`),
      "an undeliverable write was dropped without a word",
    ).toStrictEqual(["metadata:book"]);
    // The privacy bar does not move to make room for the report: the queue is
    // still gone, because it names the account and the book it renamed.
    expect(await listQueuedMutations(USER_A)).toStrictEqual([]);
  });

  /**
   * A preference change is the one user write that is not an outbox row: its
   * only record on the device is a flag in `chapterline:preferences:<userId>`,
   * a key `clearLocalDataForUser` deletes as part of this very sweep. A drain
   * that enumerated only the outbox and the playback queue therefore destroyed
   * it and reported nothing.
   */
  function seedPendingPreference(userId: string, skipBackMs: number) {
    storage.setItem(
      `chapterline:preferences:${userId}`,
      JSON.stringify({
        preferences: {
          skipBackMs,
          skipForwardMs: 30_000,
          smartRewind: true,
          autoplayNextInCollection: false,
        },
        revision: 3,
        pendingRevision: 3,
        pendingSince: 1_772_000_000_000,
      }),
    );
  }

  it("delivers a pending preference change, which is journaled in no outbox", async () => {
    const userId = "user-prefs-drain";
    seedPendingPreference(userId, 45_000);
    const sent: string[] = [];
    const fetchFn = (async (url: RequestInfo | URL) => {
      sent.push(String(url));
      return ok();
    }) as typeof fetch;

    const outcome = await purgeOnSignOut(userId, { fetchFn });

    expect(
      sent,
      "the pending preference change was never sent before its only record was deleted",
    ).toContain("/api/preferences");
    expect(outcome.undelivered).toStrictEqual([]);
  });

  it("reports a preference change the server would not take", async () => {
    const userId = "user-prefs-lost";
    seedPendingPreference(userId, 45_000);
    const fetchFn = (async () => new Response(null, { status: 503 })) as typeof fetch;

    const outcome = await purgeOnSignOut(userId, { fetchFn });

    expect(
      outcome.undelivered.map((write) => `${write.kind}:${write.entityId}`),
      "a preference change was deleted from the device without a word to the user",
    ).toStrictEqual([`preferences:${userId}`]);
    // The privacy bar does not move to make room for the report: the key names
    // the account, so it goes either way. Reporting it is the whole point.
    expect(storage.getItem(`chapterline:preferences:${userId}`)).toBe(null);
  });

  it("cannot be hung by a network that never answers", async () => {
    const userId = "user-hangs";
    await commitMetadataEdit({ userId, deviceId: "device-1" }, "book", { title: "Renamed" });
    const fetchFn = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;

    const outcome = await purgeOnSignOut(userId, { fetchFn, drainTimeoutMs: 25 });

    expect(outcome.undelivered.map((write) => write.kind)).toStrictEqual(["metadata"]);
    expect(await listQueuedMutations(userId)).toStrictEqual([]);
  });
});

/**
 * F9 — one failing step must not abandon the rest of the sweep.
 *
 * The failure is injected the way it actually happens: Cache Storage refuses to
 * open, which is what `OfflineStorageUnavailableError` exists for. That makes
 * `clearLocalDataForUser` throw, and everything after it used to be skipped —
 * leaving the deletion journal (which names the account and the books it
 * deleted) and the account's replay counters on disk under the next session.
 */
describe("a failing purge step does not abandon the ones after it", () => {
  it("still purges the deletion journal and the replay counters, and reports the failure", async () => {
    await seedAccount(USER_A);
    storage.setItem(ACTIVE_USER_KEY, USER_A);
    const openCache = caches.api.open;
    caches.api.open = (async (name: string) => {
      if (name === MEDIA_CACHE) throw new Error("Cache Storage is unavailable");
      return openCache(name);
    }) as typeof caches.api.open;

    await expect(purgeAccount(USER_A)).rejects.toThrow();

    caches.api.open = openCache;
    expect(await deletionRowsFor(USER_A), "the deletion journal outlived the failure").toBe(0);
    expect(await sequenceRowsFor(USER_A), "the replay counters outlived the failure").toBe(0);
    expect(storage.getItem(ACTIVE_USER_KEY)).toBe(null);
  });
});

/**
 * F8 — the sweep enumerates all three databases.
 *
 * `chapterline-sync-v1` and `hark-playback-history-v1` are separate databases
 * from the mirror. An account whose only surviving trace is in one of them is
 * still an account whose writes and listening the next user can read.
 */
describe("every database is enumerated", () => {
  it("finds an account whose only trace is an unsent write", async () => {
    const userId = "user-outbox-only";
    await commitMetadataEdit({ userId, deviceId: "device-1" }, "book", { title: "Renamed" });

    expect(await listLocalUserIds()).toContain(userId);
  });

  it("finds an account whose only trace is what it listened to", async () => {
    const userId = "user-history-only";
    const dead = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    await storePlaybackAction(userId, "book", playbackEntry("action-1"), dead);

    expect(await listLocalUserIds()).toContain(userId);
  });

  it("purges an account the mirror has never heard of when somebody else signs in", async () => {
    const stale = "user-outbox-only";
    await commitMetadataEdit({ userId: stale, deviceId: "device-1" }, "book", { title: "Renamed" });
    await storePlaybackAction(stale, "book", playbackEntry("action-1"), (async () => {
      throw new Error("offline");
    }) as typeof fetch);
    await seedAccount(USER_B);

    expect(await purgeOnSignIn(USER_B)).toStrictEqual([stale]);

    expect(await listQueuedMutations(stale)).toStrictEqual([]);
    expect(await listPendingPlaybackActions(stale)).toStrictEqual([]);
    expect(await listLocalUserIds()).toStrictEqual([USER_B]);
  });
});

function playbackEntry(id: string) {
  return {
    id,
    action: "seek" as const,
    positionMs: 3_000,
    previousPositionMs: 1_000,
    playbackRate: 1,
    description: null,
    occurredAt: "2026-07-01T00:00:00.000Z",
    recordedAt: "2026-07-01T00:00:01.000Z",
  };
}

async function deletionRowsFor(userId: string): Promise<number> {
  const db = await database();
  return (await db.getAll("deletions")).filter((row) => row.userId === userId).length;
}

async function sequenceRowsFor(userId: string): Promise<number> {
  const sync = await openDB("chapterline-sync-v1");
  const rows = (await sync.getAll("sequences")) as { key: string }[];
  sync.close();
  return rows.filter((row) => row.key.startsWith(`${userId}:`)).length;
}
