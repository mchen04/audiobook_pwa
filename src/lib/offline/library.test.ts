import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";

import { database, MEDIA_CACHE, offlineBookKey } from "./db";
import { removeOfflineBook } from "./deletion-journal";
import {
  getOfflineBook,
  listOfflineBooks,
  listStoredOfflineBooks,
  reattachLocalBookIdentity,
} from "./library";

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

/**
 * A Cache Storage read that misses is not proof the audio is gone.
 *
 * WebKit was measured discarding every Cache Storage *record* for this origin
 * while the cache *names* survived: a heal restored and verified 33 shell and 6
 * media entries, and seconds later both caches read zero from two pages at
 * once. So `caches.open` resolves, every `match` misses, and the reconcile that
 * runs on every `/library` visit and every player open used to read that as
 * permanent loss — deleting the download record and the book's read-along cues.
 * Putting the bytes back afterwards restores neither.
 *
 * The audio is the one thing in this product that exists nowhere else (design
 * contract section 2), and the transcript is not even addressed by the token
 * that missed. The only honest response to "I looked and did not find it" is to
 * record that this device does not currently have the audio and leave every
 * recoverable thing recoverable — which is exactly the state the player's gate
 * already renders as "Attach the original MP3".
 */
describe("a Cache Storage wipe that keeps the cache names", () => {
  /** Records gone, name still registered — the measured WebKit condition. */
  function wipeCacheRecords() {
    caches.raw.get(MEDIA_CACHE)!.store.clear();
  }

  async function storedRecord() {
    return (await database()).get("downloads", offlineBookKey(USER, CANONICAL));
  }

  it("does not destroy the download record on a library read", async () => {
    const { urls } = await storeBook(CANONICAL);
    wipeCacheRecords();

    await expect(
      listOfflineBooks(USER),
      "a book whose bytes this device cannot find must not be offered as playable",
    ).resolves.toStrictEqual([]);

    const record = await storedRecord();
    expect(
      record,
      "the only local description of a file that exists nowhere else was deleted " +
        "because one cache read missed",
    ).toBeDefined();
    expect(
      record!.mediaMissingSince,
      "the record survived but still claims this device holds the audio",
    ).toEqual(expect.any(String));
    expect(
      record!.offlineMediaUrl,
      "the handle on the bytes was erased, so a cache that comes back is unreachable",
    ).toBe(urls[0]);
  });

  it("does not destroy the read-along cues on a library read", async () => {
    await storeBook(CANONICAL);
    wipeCacheRecords();

    await listOfflineBooks(USER);

    expect(
      await transcriptKeys(),
      "the transcript is keyed by book id and was never addressed by the token that " +
        "missed; losing it because an audio blob was evicted is gratuitous",
    ).toStrictEqual([`${USER}:${CANONICAL}:000000`]);
  });

  it("does not destroy the download record or the cues when the player opens", async () => {
    await storeBook(CANONICAL);
    wipeCacheRecords();

    await expect(
      getOfflineBook(USER, CANONICAL),
      "the gate must be told this device has no audio, so it renders the attach screen",
    ).resolves.toBeUndefined();

    expect(await storedRecord()).toBeDefined();
    expect(await transcriptKeys()).toStrictEqual([`${USER}:${CANONICAL}:000000`]);
  });

  it("keeps the journaled cache rows, so bytes that come back are still owned", async () => {
    const { urls } = await storeBook(CANONICAL);
    wipeCacheRecords();

    await listOfflineBooks(USER);

    expect(
      Object.keys(await cacheEntryOwners()).sort(),
      "the sweep would reclaim these URLs as orphans the moment WebKit restored them",
    ).toStrictEqual([...urls].sort());
  });

  it("heals itself the moment the records come back", async () => {
    const { urls } = await storeBook(CANONICAL);
    const before = await mediaSnapshot();
    wipeCacheRecords();
    await listOfflineBooks(USER);

    // WebKit hands the origin its Cache Storage records back.
    const cache = await caches.api.open(MEDIA_CACHE);
    for (const url of urls) await cache.put(url, new Response(before[url]!));

    await expect(listOfflineBooks(USER)).resolves.toHaveLength(1);
    const record = await storedRecord();
    expect(
      record!.mediaMissingSince,
      "the marker is a cached observation, not a tombstone; a transient wipe must not " +
        "leave the book permanently marked",
    ).toBeFalsy();
    await expect(getOfflineBook(USER, CANONICAL)).resolves.toMatchObject({
      offlineMediaUrl: urls[0],
    });
  });

  it("leaves the book re-attachable, with its cues intact", async () => {
    await storeBook(CANONICAL);
    wipeCacheRecords();
    await listOfflineBooks(USER);
    const stale = (await storedRecord())!;

    // What the gate's "Attach MP3" button does.
    vi.stubGlobal("navigator", { storage: {} });
    const { storeLocalBookMedia } = await import("./media-store");
    const reattached = await storeLocalBookMedia(
      USER,
      stale.book,
      new File([new Uint8Array([1, 2, 3])], "same.mp3", { type: "audio/mpeg" }),
      null,
    );

    await expect(getOfflineBook(USER, CANONICAL)).resolves.toMatchObject({
      offlineMediaUrl: reattached.offlineMediaUrl,
      mediaMissingSince: null,
    });
    await expect(listOfflineBooks(USER)).resolves.toHaveLength(1);
    expect(
      await transcriptKeys(),
      "the read-along the user recorded against this book did not survive re-attaching it",
    ).toStrictEqual([`${USER}:${CANONICAL}:000000`]);
  });

  it("still deletes everything when the user actually asks for it", async () => {
    await storeBook(CANONICAL);
    wipeCacheRecords();
    await listOfflineBooks(USER);

    await removeOfflineBook(USER, CANONICAL);

    expect(
      await storedRecord(),
      "a marked record must not be undeletable — an explicit delete is still a delete",
    ).toBeUndefined();
    expect(await transcriptKeys()).toStrictEqual([]);
    expect(await cacheEntryOwners()).toStrictEqual({});
  });
});
