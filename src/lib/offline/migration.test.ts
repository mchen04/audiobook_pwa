import { beforeAll, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { openDB } from "idb";

const OFFLINE_DATABASE = "chapterline-offline-v1";
const SYNC_DATABASE = "chapterline-sync-v1";

beforeAll(async () => {
  await Promise.all([deleteDatabase(OFFLINE_DATABASE), deleteDatabase(SYNC_DATABASE)]);
});

describe("bookmark storage removal", () => {
  it("strips legacy bookmark projections from downloaded books", async () => {
    const legacy = await openDB(OFFLINE_DATABASE, 4, {
      upgrade(db) {
        const downloads = db.createObjectStore("downloads", { keyPath: "key" });
        downloads.createIndex("by-user", "userId");
        const deletions = db.createObjectStore("deletions", { keyPath: "key" });
        deletions.createIndex("by-user", "userId");
        const cacheEntries = db.createObjectStore("cacheEntries", { keyPath: "url" });
        cacheEntries.createIndex("by-user", "userId");
      },
    });
    await legacy.put("downloads", {
      key: "user-1:book-1",
      userId: "user-1",
      book: {
        id: "book-1",
        title: "Book",
        author: "Author",
        durationMs: 1_000,
        chapters: [],
        initialPositionMs: 0,
        initialProgressOccurredAt: null,
        initialPlaybackRate: 1,
        completed: false,
      },
      offlineMediaUrl: "/offline-media/book-1",
      offlineCoverUrl: null,
      byteSize: 1,
      downloadedAt: "2026-07-12T00:00:00.000Z",
      bookmarks: [{ id: "legacy-bookmark" }],
    });
    legacy.close();
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue({
        match: vi.fn().mockResolvedValue(new Response("audio")),
      }),
    });

    const { getOfflineBook } = await import("./library");
    await getOfflineBook("user-1", "book-1");

    const upgraded = await openDB(OFFLINE_DATABASE, 5);
    const record = await upgraded.get("downloads", "user-1:book-1");
    expect(record).not.toHaveProperty("bookmarks");
    upgraded.close();
  });

  it("purges legacy bookmark mutations while preserving queued progress", async () => {
    const legacy = await openDB(SYNC_DATABASE, 1, {
      upgrade(db) {
        const mutations = db.createObjectStore("mutations", { keyPath: "key" });
        mutations.createIndex("by-user", "userId");
        db.createObjectStore("sequences", { keyPath: "key" });
      },
    });
    await legacy.put("mutations", {
      key: "user-1:bookmark:legacy",
      userId: "user-1",
      kind: "bookmark",
      entry: { id: "legacy" },
    });
    await legacy.put("mutations", {
      key: "user-1:progress:book-1:device-1",
      userId: "user-1",
      kind: "progress",
      entry: {
        userId: "user-1",
        bookId: "book-1",
        deviceId: "device-1",
        deviceSequence: 1,
        positionMs: 100,
        playbackRate: 1,
        completed: false,
        eventOccurredAt: "2026-07-12T00:00:00.000Z",
      },
    });
    legacy.close();

    const { nextDeviceSequence } = await import("../offline-sync");
    await nextDeviceSequence("upgrade-trigger");

    const upgraded = await openDB(SYNC_DATABASE, 3);
    const mutations = await upgraded.getAll("mutations");
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.kind).toBe("progress");
    upgraded.close();
  });
});

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener("success", () => resolve());
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () => reject(new Error(`Could not reset ${name}`)));
  });
}
