import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OfflineBook } from "./db";

const store = vi.hoisted(() => new Map<string, OfflineBook>());
const cacheEntries = vi.hoisted(
  () => new Map<string, { url: string; userId: string; bookId: string }>(),
);
const deletions = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const cachedUrls = vi.hoisted(() => new Set<string>());
const fakeDb = vi.hoisted(() => ({
  getAllFromIndex: vi.fn(async (name: string) => [
    ...(name === "downloads"
      ? store.values()
      : name === "cacheEntries"
        ? cacheEntries.values()
        : deletions.values()),
  ]),
  getAll: vi.fn(async (name: string) => [
    ...(name === "downloads"
      ? store.values()
      : name === "cacheEntries"
        ? cacheEntries.values()
        : deletions.values()),
  ]),
  get: vi.fn(async (name: string, key: string) =>
    name === "downloads"
      ? store.get(key)
      : name === "cacheEntries"
        ? cacheEntries.get(key)
        : deletions.get(key),
  ),
  put: vi.fn(async (name: string, record: OfflineBook & { url?: string }) => {
    if (name === "downloads") store.set(record.key, record);
    else if (name === "cacheEntries" && record.url) {
      cacheEntries.set(record.url, record as never);
    } else deletions.set(record.key, record);
  }),
  delete: vi.fn(async (name: string, key: string) => {
    if (name === "downloads") store.delete(key);
    else if (name === "cacheEntries") cacheEntries.delete(key);
    else deletions.delete(key);
  }),
  getAllKeys: vi.fn(async (name: string, range?: { lower: string; upper: string }) => {
    const keys = [
      ...(name === "downloads"
        ? store.keys()
        : name === "cacheEntries"
          ? cacheEntries.keys()
          : deletions.keys()),
    ];
    return range ? keys.filter((key) => key >= range.lower && key <= range.upper) : keys;
  }),
  transaction: vi.fn((name: string) => {
    const target =
      name === "downloads" ? store : name === "cacheEntries" ? cacheEntries : deletions;
    return {
      store: {
        get: async (key: string) => target.get(key as never),
        put: async (record: { key?: string; url?: string }) => {
          target.set((record.url ?? record.key)!, record as never);
        },
        delete: async (key: string) => {
          target.delete(key);
        },
      },
      done: Promise.resolve(),
    };
  }),
}));

vi.stubGlobal("IDBKeyRange", {
  bound: (lower: string, upper: string) => ({ lower, upper }),
});

vi.mock("idb", () => ({
  openDB: vi.fn().mockResolvedValue(fakeDb),
}));

import { retryAllPendingOfflineDeletions } from "./deletion-journal";
import { getOfflineBook, listOfflineBooks } from "./library";
import { storeLocalBookMedia } from "./media-store";

describe("offline media recovery", () => {
  beforeEach(() => {
    store.clear();
    cacheEntries.clear();
    deletions.clear();
    cachedUrls.clear();
    fakeDb.get.mockClear();
    fakeDb.put.mockClear();
    fakeDb.delete.mockClear();
    fakeDb.getAllKeys.mockClear();
    fakeDb.transaction.mockClear();
    vi.stubGlobal("caches", {
      open: vi.fn(async () => ({
        match: vi.fn(async (url: string) =>
          cachedUrls.has(url) ? new Response("media") : undefined,
        ),
        delete: vi.fn(async (url: string) => cachedUrls.delete(url)),
      })),
    });
  });

  it("reconciles an evicted download consistently during a library read", async () => {
    const stale = offlineBook("stale", "2026-07-10T01:00:00.000Z");
    const available = offlineBook("available", "2026-07-10T02:00:00.000Z");
    store.set(stale.key, stale);
    store.set(available.key, available);
    cachedUrls.add(available.offlineMediaUrl);

    await expect(listOfflineBooks("user")).resolves.toEqual([available]);
    expect(store.has(stale.key)).toBe(false);
  });

  it("treats an evicted cache entry as missing media instead of opening a broken player", async () => {
    const stale = offlineBook("stale", "2026-07-10T01:00:00.000Z");
    store.set(stale.key, stale);

    await expect(getOfflineBook("user", stale.book.id)).resolves.toBeUndefined();
    expect(store.has(stale.key)).toBe(false);
  });

  it("preserves the download record when Cache Storage is temporarily unavailable", async () => {
    const record = offlineBook("saved", "2026-07-10T01:00:00.000Z");
    store.set(record.key, record);
    vi.stubGlobal("caches", {
      open: vi.fn(async () => ({ match: vi.fn().mockRejectedValue(new Error("cache busy")) })),
    });

    await expect(getOfflineBook("user", record.book.id)).rejects.toMatchObject({
      name: "OfflineStorageUnavailableError",
    });
    expect(store.get(record.key)).toBe(record);
  });

  it("reads a newly stored MP3 back from IndexedDB and Cache Storage", async () => {
    const media = new Map<string, Response>();
    vi.stubGlobal("caches", {
      open: vi.fn(async () => ({
        put: vi.fn(async (url: string, response: Response) => {
          media.set(url, response);
        }),
        match: vi.fn(async (url: string) => media.get(url)?.clone()),
        delete: vi.fn(async (url: string) => media.delete(url)),
      })),
    });
    vi.stubGlobal("navigator", {
      storage: {
        estimate: vi.fn().mockResolvedValue({ quota: 1_000_000, usage: 0 }),
        persist: vi.fn().mockResolvedValue(true),
      },
    });
    const book = offlineBook("new", new Date().toISOString()).book;

    const saved = await storeLocalBookMedia("user", book, mediaFile(), null);
    const reloaded = await getOfflineBook("user", book.id);

    expect(reloaded).toEqual(saved);
    expect(
      await (await caches.open("chapterline-media-v2")).match(saved.offlineMediaUrl),
    ).toBeDefined();
  });

  it("stores audiobook-sized media as bounded chunks instead of one large response", async () => {
    const media = new Map<string, Response>();
    vi.stubGlobal("caches", {
      open: vi.fn(async () => ({
        put: vi.fn(async (url: string, response: Response) => media.set(url, response)),
        match: vi.fn(async (url: string) => media.get(url)?.clone()),
        delete: vi.fn(async (url: string) => media.delete(url)),
      })),
    });
    vi.stubGlobal("navigator", { storage: {} });
    const book = offlineBook("chunked", new Date().toISOString()).book;
    const file = new File([new Uint8Array(4 * 1024 * 1024 + 7)], "large.mp3", {
      type: "audio/mpeg",
    });

    const saved = await storeLocalBookMedia("user", book, file, null);
    const manifest = await media.get(saved.offlineMediaUrl)!.clone().json();

    expect(manifest).toMatchObject({
      format: "chapterline-chunked-media-v1",
      byteSize: file.size,
      chunkSize: 4 * 1024 * 1024,
      chunkCount: 2,
    });
    expect(media.get(`${saved.offlineMediaUrl}/chunk/0`)).toBeDefined();
    expect(media.get(`${saved.offlineMediaUrl}/chunk/1`)).toBeDefined();
    expect((await media.get(`${saved.offlineMediaUrl}/chunk/0`)!.clone().blob()).size).toBe(
      4 * 1024 * 1024,
    );
  });

  it("keeps the original storage failure when best-effort cache cleanup also fails", async () => {
    const deleteEntry = vi.fn().mockRejectedValue(new Error("cleanup failed"));
    vi.stubGlobal("caches", {
      open: vi.fn(async () => ({
        put: vi.fn().mockRejectedValue(new Error("cache unavailable")),
        delete: deleteEntry,
      })),
    });
    vi.stubGlobal("navigator", { storage: {} });

    await expect(
      storeLocalBookMedia(
        "user",
        offlineBook("new", new Date().toISOString()).book,
        mediaFile(),
        null,
      ),
    ).rejects.toThrow("This device could not save the audiobook for offline playback");
    // Every journaled row (chunk and manifest) gets a best-effort cache sweep.
    expect(deleteEntry).toHaveBeenCalledTimes(2);
  });

  it("normalizes journal failures before writing any unowned cache entry", async () => {
    const deleteEntry = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("caches", {
      open: vi.fn(async () => ({
        match: vi.fn().mockResolvedValue(undefined),
        put: vi.fn().mockResolvedValue(undefined),
        delete: deleteEntry,
      })),
    });
    vi.stubGlobal("navigator", {
      storage: {
        estimate: vi.fn().mockRejectedValue(new Error("estimate unavailable")),
        persist: vi.fn().mockResolvedValue(false),
      },
    });
    fakeDb.transaction.mockImplementationOnce(() => ({
      store: {
        get: async () => undefined,
        put: () => Promise.reject(new Error("indexeddb unavailable")),
        delete: async () => undefined,
      },
      done: Promise.resolve(),
    }));

    await expect(
      storeLocalBookMedia(
        "user",
        offlineBook("new", new Date().toISOString()).book,
        mediaFile(),
        null,
      ),
    ).rejects.toThrow("This device could not save the audiobook for offline playback");
    expect(deleteEntry).not.toHaveBeenCalled();
  });

  it("reconciles a crash-orphaned journaled cache entry", async () => {
    const url = "/offline-media/orphan";
    cacheEntries.set(url, { url, userId: "user", bookId: "orphan-book" });
    cachedUrls.add(url);
    vi.stubGlobal("navigator", { storage: {} });

    await retryAllPendingOfflineDeletions();

    expect(cachedUrls.has(url)).toBe(false);
    expect(cacheEntries.has(url)).toBe(false);
  });

  it("launch sweep of a fully owned chunked library does no per-entry reads", async () => {
    const record = offlineBook("big", "2026-07-10T01:00:00.000Z");
    record.offlineCoverUrl = "/offline-media/big-cover";
    record.offlineCoverThumbUrl = "/offline-media/big-cover-thumb";
    store.set(record.key, record);
    const owned = [record.offlineMediaUrl, record.offlineCoverUrl, record.offlineCoverThumbUrl];
    for (let index = 0; index < 500; index += 1) {
      owned.push(`${record.offlineMediaUrl}/chunk/${index}`);
    }
    for (const url of owned) {
      cacheEntries.set(url, { url, userId: "user", bookId: "big" });
      cachedUrls.add(url);
    }
    vi.stubGlobal("navigator", { storage: {} });
    fakeDb.get.mockClear();

    await retryAllPendingOfflineDeletions();

    expect(cacheEntries.size).toBe(owned.length);
    expect(cachedUrls.size).toBe(owned.length);
    // The sweep must stay an in-memory diff: per-chunk gets or locks froze
    // startup for multi-gigabyte audiobooks.
    expect(fakeDb.get).not.toHaveBeenCalled();
  });

  it("sweeps a crashed import's chunk rows while keeping the owned book intact", async () => {
    const kept = offlineBook("kept", "2026-07-10T01:00:00.000Z");
    store.set(kept.key, kept);
    const keptUrls = [kept.offlineMediaUrl, `${kept.offlineMediaUrl}/chunk/0`];
    const lostUrls = ["/offline-media/lost", "/offline-media/lost/chunk/0"];
    for (const url of keptUrls) {
      cacheEntries.set(url, { url, userId: "user", bookId: "kept" });
      cachedUrls.add(url);
    }
    for (const url of lostUrls) {
      cacheEntries.set(url, { url, userId: "user", bookId: "lost" });
      cachedUrls.add(url);
    }
    vi.stubGlobal("navigator", { storage: {} });

    await retryAllPendingOfflineDeletions();

    for (const url of lostUrls) {
      expect(cacheEntries.has(url)).toBe(false);
      expect(cachedUrls.has(url)).toBe(false);
    }
    for (const url of keptUrls) {
      expect(cacheEntries.has(url)).toBe(true);
      expect(cachedUrls.has(url)).toBe(true);
    }
  });

  it("journals every chunk row in one transaction and reports save progress", async () => {
    const media = new Map<string, Response>();
    vi.stubGlobal("caches", {
      open: vi.fn(async () => ({
        put: vi.fn(async (url: string, response: Response) => media.set(url, response)),
        match: vi.fn(async (url: string) => media.get(url)?.clone()),
        delete: vi.fn(async (url: string) => media.delete(url)),
      })),
    });
    vi.stubGlobal("navigator", { storage: {} });
    const book = offlineBook("batched", new Date().toISOString()).book;
    const file = new File([new Uint8Array(4 * 1024 * 1024 + 7)], "large.mp3", {
      type: "audio/mpeg",
    });
    const progress: number[] = [];

    await storeLocalBookMedia("user", book, file, null, (fraction) => progress.push(fraction));

    expect(fakeDb.transaction).toHaveBeenCalledTimes(1);
    // Chunk journal rows go through the batched transaction, so the only
    // direct put is the downloads record.
    expect(fakeDb.put).toHaveBeenCalledTimes(1);
    expect(progress.at(-1)).toBe(1);
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect([...progress].sort((left, right) => left - right)).toEqual(progress);
  });
});

function offlineBook(id: string, downloadedAt: string): OfflineBook {
  return {
    key: `user:${id}`,
    userId: "user",
    book: {
      id,
      title: id,
      author: "Author",
      durationMs: 8_000,
      chapters: [{ id: `${id}:0`, position: 0, title: "Full", startMs: 0, endMs: 8_000 }],
      initialPositionMs: 0,
      initialProgressOccurredAt: null,
      initialPlaybackRate: 1,
      completed: false,
    },
    offlineMediaUrl: `/offline-media/${id}`,
    offlineCoverUrl: null,
    byteSize: 3,
    downloadedAt,
  };
}

function mediaFile() {
  return new File([new Uint8Array([1, 2, 3])], "fixture.mp3", { type: "audio/mpeg" });
}
