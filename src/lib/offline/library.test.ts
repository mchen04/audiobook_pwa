import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";

import { database, MEDIA_CACHE, offlineBookKey } from "./db";
import { listStoredOfflineBooks, reattachLocalBookIdentity } from "./library";

/**
 * Re-import while offline — `docs/local-first.md` section 10.
 *
 * An import queued with the network down is filed under an id this device
 * minted. When it finally replays and the server answers "that fingerprint is
 * already book Y", this device has to end up holding ONE book, still playable,
 * under Y. The tests below are about how that is allowed to happen as much as
 * that it happens: the bytes in Cache Storage are asserted byte-for-byte
 * identical across the move, because the file underneath can be a 600-hour MP3
 * and the copy on this device is the only one in existence.
 */

const USER = "user-a";
const MINTED = "minted-book-id";
const CANONICAL = "canonical-book-id";

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
  return { api: { open, keys: async () => [...caches.keys()] }, raw: caches };
}

let caches: ReturnType<typeof fakeCaches>;

beforeEach(() => {
  vi.stubGlobal("indexedDB", new FakeIDBFactory());
  caches = fakeCaches();
  vi.stubGlobal("caches", caches.api);
});

/** One imported audiobook exactly as `media-store.ts` leaves it on the device. */
async function storeBook(
  bookId: string,
  options: { chunks?: number; cues?: boolean; title?: string } = {},
) {
  const { chunks = 3, cues = true, title = "Offline import" } = options;
  const db = await database();
  const token = `token-${bookId}`;
  const offlineMediaUrl = `/offline-media/${token}`;
  const coverUrl = `${offlineMediaUrl}-cover`;
  const cache = await (globalThis.caches as unknown as ReturnType<typeof fakeCaches>["api"]).open(
    MEDIA_CACHE,
  );
  const urls = [
    offlineMediaUrl,
    ...Array.from({ length: chunks }, (_, index) => `${offlineMediaUrl}/chunk/${index}`),
    coverUrl,
  ];
  for (const url of urls) {
    await db.put("cacheEntries", { url, userId: USER, bookId });
    await cache.put(url, new Response(`bytes of ${url}`));
  }
  await db.put("downloads", {
    key: offlineBookKey(USER, bookId),
    userId: USER,
    book: {
      id: bookId,
      title,
      author: "Author",
      durationMs: 600_000,
      chapters: [{ id: `${bookId}:0`, position: 0, title: "One", startMs: 0, endMs: 600_000 }],
      initialPositionMs: 0,
      initialProgressOccurredAt: null,
      initialPlaybackRate: 1,
      completed: false,
    },
    offlineMediaUrl,
    offlineCoverUrl: coverUrl,
    offlineCoverThumbUrl: null,
    byteSize: 12_582_912,
    downloadedAt: "2026-07-20T00:00:00.000Z",
  });
  if (cues) {
    await db.put("transcripts", {
      key: `${USER}:${bookId}:000000`,
      userId: USER,
      bookId,
      chapterIndex: 0,
      granularity: "sentence",
      sentences: [{ index: 0, startMs: 0, endMs: 1_000, text: "The lantern flickered." }] as never,
    });
  }
  return { offlineMediaUrl, coverUrl, urls };
}

async function mediaSnapshot(): Promise<Record<string, string>> {
  const cache = caches.raw.get(MEDIA_CACHE);
  const snapshot: Record<string, string> = {};
  for (const [url, response] of cache?.store || []) {
    snapshot[url] = await response.clone().text();
  }
  return snapshot;
}

async function cacheEntryOwners(): Promise<Record<string, string>> {
  const db = await database();
  const owners: Record<string, string> = {};
  for (const row of await db.getAllFromIndex("cacheEntries", "by-user", USER)) {
    owners[row.url] = row.bookId;
  }
  return owners;
}

async function transcriptKeys(): Promise<string[]> {
  const db = await database();
  return (await db.getAllFromIndex("transcripts", "by-user", USER)).map((row) => row.key);
}

describe("reattaching an offline import to the book the server already has", () => {
  it("moves the identity and leaves every stored byte exactly where it was", async () => {
    const { offlineMediaUrl } = await storeBook(MINTED);
    const before = await mediaSnapshot();

    await reattachLocalBookIdentity(USER, MINTED, CANONICAL);

    const records = await listStoredOfflineBooks(USER);
    expect(
      records.map((record) => record.book.id),
      "the device holds the audio twice, or under an id no pull will ever mention",
    ).toStrictEqual([CANONICAL]);
    expect(records[0]!.key).toBe(offlineBookKey(USER, CANONICAL));
    expect(
      records[0]!.offlineMediaUrl,
      "the media token was rewritten, which means the bytes were re-keyed rather than the record",
    ).toBe(offlineMediaUrl);
    expect(records[0]!.book.chapters[0]!.id).toBe(`${CANONICAL}:0`);
    expect(
      await mediaSnapshot(),
      "Cache Storage changed. A multi-gigabyte audiobook must never be copied or deleted to " +
        "rename it — the only copy of the file lives here.",
    ).toStrictEqual(before);
  });

  it("takes the cache journal with it so the sweep and the purge still find the bytes", async () => {
    const { urls } = await storeBook(MINTED);

    await reattachLocalBookIdentity(USER, MINTED, CANONICAL);

    const owners = await cacheEntryOwners();
    expect(Object.keys(owners).sort()).toStrictEqual([...urls].sort());
    expect(new Set(Object.values(owners))).toStrictEqual(new Set([CANONICAL]));
  });

  it("takes the read-along cues with it", async () => {
    await storeBook(MINTED);

    await reattachLocalBookIdentity(USER, MINTED, CANONICAL);

    expect(await transcriptKeys()).toStrictEqual([`${USER}:${CANONICAL}:000000`]);
  });

  it("adopts the canonical book the 409 carried, so the saved position survives", async () => {
    await storeBook(MINTED, { title: "Local guess" });

    await reattachLocalBookIdentity(USER, MINTED, CANONICAL, {
      id: CANONICAL,
      title: "Server title",
      author: "Server author",
      durationMs: 600_000,
      chapters: [{ id: "chapter-uuid", position: 0, title: "One", startMs: 0, endMs: 600_000 }],
      initialPositionMs: 4_500,
      initialProgressOccurredAt: "2026-07-21T00:00:00.000Z",
      initialPlaybackRate: 1.25,
      completed: false,
    });

    const [record] = await listStoredOfflineBooks(USER);
    expect(record!.book.title).toBe("Server title");
    expect(record!.book.initialPositionMs).toBe(4_500);
    expect(record!.book.chapters[0]!.id).toBe("chapter-uuid");
  });

  it("ignores an unusable playerBook rather than overwriting the local description", async () => {
    await storeBook(MINTED, { title: "Local guess" });

    await reattachLocalBookIdentity(USER, MINTED, CANONICAL, { id: CANONICAL, title: 7 });

    const [record] = await listStoredOfflineBooks(USER);
    expect(record!.book.title).toBe("Local guess");
    expect(record!.book.id).toBe(CANONICAL);
  });

  it("is safe to run again, which is what makes an interrupted drain harmless", async () => {
    await storeBook(MINTED);
    await reattachLocalBookIdentity(USER, MINTED, CANONICAL);
    const after = await mediaSnapshot();

    await reattachLocalBookIdentity(USER, MINTED, CANONICAL);

    const records = await listStoredOfflineBooks(USER);
    expect(records.map((record) => record.book.id)).toStrictEqual([CANONICAL]);
    expect(await mediaSnapshot()).toStrictEqual(after);
    expect(await transcriptKeys()).toStrictEqual([`${USER}:${CANONICAL}:000000`]);
  });

  it("does nothing at all when this device stored nothing under the imported id", async () => {
    await reattachLocalBookIdentity(USER, MINTED, CANONICAL);

    expect(await listStoredOfflineBooks(USER)).toStrictEqual([]);
    expect(await mediaSnapshot()).toStrictEqual({});
  });

  it("keeps the copy already filed under the canonical id and drops the duplicate", async () => {
    const canonical = await storeBook(CANONICAL, { title: "The one that stays" });
    const duplicate = await storeBook(MINTED, { title: "Second import of the same file" });

    await reattachLocalBookIdentity(USER, MINTED, CANONICAL);

    const records = await listStoredOfflineBooks(USER);
    expect(records.map((record) => record.book.id)).toStrictEqual([CANONICAL]);
    expect(records[0]!.offlineMediaUrl).toBe(canonical.offlineMediaUrl);
    const media = await mediaSnapshot();
    for (const url of canonical.urls) {
      expect(media[url], "the surviving book lost bytes it still owns").toBeDefined();
    }
    for (const url of duplicate.urls) {
      expect(media[url], "the redundant second copy is still occupying storage").toBeUndefined();
    }
    expect(await cacheEntryOwners()).toStrictEqual(
      Object.fromEntries(canonical.urls.map((url) => [url, CANONICAL])),
    );
    expect(await transcriptKeys()).toStrictEqual([`${USER}:${CANONICAL}:000000`]);
  });

  it("never deletes the audio when the canonical id has a record but no bytes", async () => {
    // Exactly the section 10 case: the book is known here, its audio was
    // evicted, and the same MP3 was imported again while offline.
    const db = await database();
    const evicted = await storeBook(CANONICAL);
    for (const url of evicted.urls) {
      await (await caches.api.open(MEDIA_CACHE)).delete(url);
      await db.delete("cacheEntries", url);
    }
    const reimported = await storeBook(MINTED);

    await reattachLocalBookIdentity(USER, MINTED, CANONICAL);

    const records = await listStoredOfflineBooks(USER);
    expect(records.map((record) => record.book.id)).toStrictEqual([CANONICAL]);
    expect(records[0]!.offlineMediaUrl).toBe(reimported.offlineMediaUrl);
    const media = await mediaSnapshot();
    for (const url of reimported.urls) {
      expect(media[url], "the re-imported audio was destroyed by the merge").toBeDefined();
    }
  });
});
