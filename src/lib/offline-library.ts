import { openDB, type DBSchema } from "idb";

import type { Bookmark, PlayerBook } from "@/domain/player";
import { clearQueuedMutationsForUser } from "@/lib/offline-sync";

const DATABASE_NAME = "chapterline-offline-v1";
const MEDIA_CACHE = "chapterline-media-v1";
const activeMediaWrites = new Map<string, Promise<unknown>>();

export type OfflineBook = {
  key: string;
  userId: string;
  book: Omit<PlayerBook, "mediaUrl" | "coverUrl">;
  offlineMediaUrl: string;
  offlineCoverUrl: string | null;
  byteSize: number;
  downloadedAt: string;
  bookmarks?: Bookmark[];
};

export class OfflineStorageUnavailableError extends Error {
  constructor() {
    super("This device's offline storage is temporarily unavailable.");
    this.name = "OfflineStorageUnavailableError";
  }
}

interface OfflineDatabase extends DBSchema {
  downloads: {
    key: string;
    value: OfflineBook;
    indexes: { "by-user": string };
  };
  deletions: {
    key: string;
    value: {
      key: string;
      userId: string;
      bookId: string;
      offlineMediaUrl?: string;
      offlineCoverUrl?: string | null;
      completedAt?: number;
    };
    indexes: { "by-user": string };
  };
  cacheEntries: {
    key: string;
    value: { url: string; userId: string; bookId: string };
    indexes: { "by-user": string };
  };
}

function database() {
  return openDB<OfflineDatabase>(DATABASE_NAME, 4, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const downloads = db.createObjectStore("downloads", { keyPath: "key" });
        downloads.createIndex("by-user", "userId");
      }
      if (oldVersion < 2) {
        const deletions = db.createObjectStore("deletions", { keyPath: "key" });
        deletions.createIndex("by-user", "userId");
      }
      if (oldVersion < 4) {
        const entries = db.createObjectStore("cacheEntries", { keyPath: "url" });
        entries.createIndex("by-user", "userId");
      }
    },
  });
}

export async function listOfflineBooks(userId: string): Promise<OfflineBook[]> {
  await retryPendingOfflineDeletions(userId);
  const records = await listStoredOfflineBooks(userId);
  const db = await database();
  const cache = await caches.open(MEDIA_CACHE);
  const reconciled = await Promise.all(
    records.map((record) => reconcileOfflineRecord(db, cache, record)),
  );
  return reconciled
    .filter((record): record is OfflineBook => !!record)
    .sort((left, right) => right.downloadedAt.localeCompare(left.downloadedAt));
}

async function listStoredOfflineBooks(userId: string): Promise<OfflineBook[]> {
  const db = await database();
  return db.getAllFromIndex("downloads", "by-user", userId);
}

export async function getOfflineBook(userId: string, bookId: string) {
  try {
    const db = await database();
    const key = offlineBookKey(userId, bookId);
    const record = await db.get("downloads", key);
    if (!record) return undefined;

    const cache = await caches.open(MEDIA_CACHE);
    const reconciled = await reconcileOfflineRecord(db, cache, record);
    return reconciled;
  } catch {
    throw new OfflineStorageUnavailableError();
  }
}

async function reconcileOfflineRecord(
  db: Awaited<ReturnType<typeof database>>,
  cache: Cache,
  record: OfflineBook,
) {
  if (await cache.match(record.offlineMediaUrl)) return record;
  if (record.offlineCoverUrl) {
    await deleteJournaledCacheEntry(db, cache, record.offlineCoverUrl).catch(() => false);
  }
  await db.delete("cacheEntries", record.offlineMediaUrl);
  await db.delete("downloads", record.key);
  return undefined;
}

export async function removeOfflineBook(userId: string, bookId: string) {
  const key = offlineBookKey(userId, bookId);
  await withMediaWriteLock(key, async () => {
    const db = await database();
    const existing = await db.get("downloads", key);
    await db.put("deletions", {
      key,
      userId,
      bookId,
      offlineMediaUrl: existing?.offlineMediaUrl,
      offlineCoverUrl: existing?.offlineCoverUrl,
    });
    await completeOfflineDeletion(db, key);
  });
}

export async function retryPendingOfflineDeletions(userId: string): Promise<void> {
  const db = await database();
  const pending = await db.getAllFromIndex("deletions", "by-user", userId);
  await Promise.all(
    pending
      .filter((entry) => typeof entry.bookId === "string" && !entry.completedAt)
      .map((entry) => withMediaWriteLock(entry.key, () => completeOfflineDeletion(db, entry.key))),
  );
}

export async function retryAllPendingOfflineDeletions(): Promise<void> {
  const db = await database();
  const pending = await db.getAll("deletions");
  const now = Date.now();
  await Promise.allSettled(
    pending.map((entry) =>
      entry.completedAt
        ? entry.completedAt < now - 24 * 60 * 60_000
          ? db.delete("deletions", entry.key)
          : Promise.resolve()
        : withMediaWriteLock(entry.key, () => completeOfflineDeletion(db, entry.key)),
    ),
  );
  await reconcileOrphanedCacheEntries(db);
}

async function completeOfflineDeletion(
  db: Awaited<ReturnType<typeof database>>,
  key: string,
): Promise<void> {
  const pending = await db.get("deletions", key);
  const existing = await db.get("downloads", key);
  const mediaUrl = pending?.offlineMediaUrl || existing?.offlineMediaUrl;
  const coverUrl = pending?.offlineCoverUrl || existing?.offlineCoverUrl;
  if (mediaUrl) {
    const cache = await caches.open(MEDIA_CACHE);
    await deleteJournaledCacheEntry(db, cache, mediaUrl);
    if (coverUrl) await deleteJournaledCacheEntry(db, cache, coverUrl);
  }
  await db.delete("downloads", key);
  if (pending) {
    await db.put("deletions", {
      ...pending,
      offlineMediaUrl: undefined,
      offlineCoverUrl: undefined,
      completedAt: Date.now(),
    });
  }
}

export async function storeOfflineBookmarks(
  userId: string,
  bookId: string,
  bookmarks: Bookmark[],
): Promise<void> {
  const db = await database();
  const key = offlineBookKey(userId, bookId);
  const record = await db.get("downloads", key);
  if (record) await db.put("downloads", { ...record, bookmarks });
}

export async function projectOfflineBookmark(
  userId: string,
  bookId: string,
  mutation:
    | { kind: "upsert"; bookmark: Bookmark }
    | { kind: "delete"; bookmarkId: string }
    | { kind: "note"; bookmarkId: string; note: string | null },
): Promise<void> {
  const db = await database();
  const transaction = db.transaction("downloads", "readwrite");
  const key = offlineBookKey(userId, bookId);
  const record = await transaction.store.get(key);
  if (record) {
    const bookmarks = record.bookmarks || [];
    const next =
      mutation.kind === "delete"
        ? bookmarks.filter((bookmark) => bookmark.id !== mutation.bookmarkId)
        : mutation.kind === "note"
          ? bookmarks.map((bookmark) =>
              bookmark.id === mutation.bookmarkId ? { ...bookmark, note: mutation.note } : bookmark,
            )
          : [
              ...bookmarks.filter((bookmark) => bookmark.id !== mutation.bookmark.id),
              mutation.bookmark,
            ].sort((left, right) => left.positionMs - right.positionMs);
    await transaction.store.put({ ...record, bookmarks: next });
  }
  await transaction.done;
}

export async function projectOfflineProgress(
  userId: string,
  bookId: string,
  state: {
    positionMs: number;
    completed: boolean;
    playbackRate: number;
    eventOccurredAt: string | null;
  },
): Promise<void> {
  const db = await database();
  const transaction = db.transaction("downloads", "readwrite");
  const key = offlineBookKey(userId, bookId);
  const record = await transaction.store.get(key);
  if (record) {
    await transaction.store.put({
      ...record,
      book: {
        ...record.book,
        initialPositionMs: state.positionMs,
        initialProgressOccurredAt: state.eventOccurredAt,
        initialPlaybackRate: state.playbackRate,
        completed: state.completed,
      },
    });
  }
  await transaction.done;
}

/**
 * Stores an imported MP3's bytes on this device: the file goes into the media
 * cache as-is (Blob-backed, so nothing is read into memory) and a downloads
 * record makes it playable. This is the only place audio ever lives — the
 * server holds metadata only.
 */
export async function storeLocalBookMedia(
  userId: string,
  book: Omit<PlayerBook, "mediaUrl" | "coverUrl">,
  file: File,
  artwork: { data: Uint8Array; mimeType: string } | null,
  bookmarks: Bookmark[] = [],
): Promise<OfflineBook> {
  const key = offlineBookKey(userId, book.id);
  const startedAt = Date.now();
  return withMediaWriteLock(key, async () => {
    const pending = await (await database()).get("deletions", key);
    if (pending?.completedAt && pending.completedAt >= startedAt) {
      throw new Error("This download was removed while it was being saved.");
    }
    return storeLocalBookMediaUnlocked(userId, book, file, artwork, bookmarks);
  });
}

async function storeLocalBookMediaUnlocked(
  userId: string,
  book: Omit<PlayerBook, "mediaUrl" | "coverUrl">,
  file: File,
  artwork: { data: Uint8Array; mimeType: string } | null,
  bookmarks: Bookmark[],
): Promise<OfflineBook> {
  await ensureStorageCapacity(file.size);
  if (navigator.storage?.persist) await navigator.storage.persist().catch(() => false);

  const token = crypto.randomUUID();
  const offlineMediaUrl = `/offline-media/${token}`;
  const key = offlineBookKey(userId, book.id);
  const db = await database();
  try {
    await db.put("cacheEntries", { url: offlineMediaUrl, userId, bookId: book.id });
  } catch (error) {
    throw offlineStorageError(error);
  }
  let cache: Cache | undefined;
  try {
    cache = await caches.open(MEDIA_CACHE);
    await cache.put(
      offlineMediaUrl,
      new Response(file, {
        status: 200,
        statusText: "OK",
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(file.size),
          "Content-Disposition": "inline",
          "Accept-Ranges": "bytes",
        },
      }),
    );
  } catch (error) {
    if (cache) await deleteJournaledCacheEntry(db, cache, offlineMediaUrl).catch(() => false);
    else await db.delete("cacheEntries", offlineMediaUrl).catch(() => undefined);
    throw offlineStorageError(error);
  }

  let offlineCoverUrl: string | null = null;
  if (artwork) {
    try {
      offlineCoverUrl = `/offline-media/${token}-cover`;
      await db.put("cacheEntries", { url: offlineCoverUrl, userId, bookId: book.id });
      await cache.put(
        offlineCoverUrl,
        new Response(new Blob([Uint8Array.from(artwork.data)], { type: artwork.mimeType }), {
          headers: { "Content-Type": artwork.mimeType },
        }),
      );
    } catch {
      if (offlineCoverUrl) {
        await deleteJournaledCacheEntry(db, cache, offlineCoverUrl).catch(() => false);
      }
      offlineCoverUrl = null;
    }
  }

  const record: OfflineBook = {
    key,
    userId,
    book,
    offlineMediaUrl,
    offlineCoverUrl,
    byteSize: file.size,
    downloadedAt: new Date().toISOString(),
    bookmarks,
  };

  let existing: OfflineBook | undefined;
  try {
    existing = await getOfflineBook(userId, book.id);
    await db.put("downloads", record);
    const [storedRecord, storedMedia] = await Promise.all([
      db.get("downloads", key),
      cache.match(offlineMediaUrl),
    ]);
    if (storedRecord?.offlineMediaUrl !== offlineMediaUrl || !storedMedia) {
      throw new Error("Offline media verification failed.");
    }
    if (existing) {
      await deleteJournaledCacheEntry(db, cache, existing.offlineMediaUrl).catch(() => false);
      if (existing.offlineCoverUrl) {
        await deleteJournaledCacheEntry(db, cache, existing.offlineCoverUrl).catch(() => false);
      }
    }
    return record;
  } catch (error) {
    const current = await db.get("downloads", key).catch(() => undefined);
    if (current?.offlineMediaUrl === offlineMediaUrl) {
      if (existing) await db.put("downloads", existing).catch(() => undefined);
      else await db.delete("downloads", key).catch(() => undefined);
    }
    await deleteJournaledCacheEntry(db, cache, offlineMediaUrl).catch(() => false);
    if (offlineCoverUrl) {
      await deleteJournaledCacheEntry(db, cache, offlineCoverUrl).catch(() => false);
    }
    throw offlineStorageError(error);
  }
}

async function withMediaWriteLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  if (navigator.locks?.request) {
    return navigator.locks.request(`chapterline-media:${key}`, operation);
  }
  const previous = activeMediaWrites.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  activeMediaWrites.set(key, current);
  try {
    return await current;
  } finally {
    if (activeMediaWrites.get(key) === current) activeMediaWrites.delete(key);
  }
}

export function asOfflinePlayerBook(record: OfflineBook): PlayerBook {
  return {
    ...record.book,
    mediaUrl: record.offlineMediaUrl,
    coverUrl: record.offlineCoverUrl,
  };
}

export function hasEnoughCapacity(
  estimate: { quota?: number; usage?: number },
  requiredBytes: number,
) {
  if (!requiredBytes || !estimate.quota) return true;
  const available = estimate.quota - (estimate.usage || 0);
  return available >= requiredBytes * 1.08;
}

async function ensureStorageCapacity(requiredBytes: number) {
  if (!navigator.storage?.estimate) return;
  const estimate = await navigator.storage.estimate().catch(() => null);
  if (!estimate) return;
  if (!hasEnoughCapacity(estimate, requiredBytes)) {
    throw new Error("This device does not have enough free storage.");
  }
}

/**
 * Removes every locally stored trace of one account: downloads, cached media,
 * queued mutations, positions, and preferences. Other accounts on the same
 * device keep their data.
 */
export async function clearLocalDataForUser(userId: string): Promise<void> {
  const downloads = await listStoredOfflineBooks(userId);
  const cleanup = await Promise.allSettled(
    downloads.map((record) => removeOfflineBook(userId, record.book.id)),
  );
  const cacheCleanupFailed = cleanup.some((result) => result.status === "rejected");
  const db = await database();
  const orphaned = await db.getAllFromIndex("cacheEntries", "by-user", userId);
  const orphanCleanup = await Promise.allSettled(
    orphaned.map((entry) =>
      withMediaWriteLock(offlineBookKey(userId, entry.bookId), async () => {
        const cache = await caches.open(MEDIA_CACHE);
        await deleteJournaledCacheEntry(db, cache, entry.url);
      }),
    ),
  );

  const keysToRemove: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.includes(`:${userId}`)) keysToRemove.push(key);
  }
  keysToRemove.forEach((key) => localStorage.removeItem(key));

  await clearQueuedMutationsForUser(userId);
  if (localStorage.getItem("chapterline:active-user") === userId) {
    localStorage.removeItem("chapterline:active-user");
  }
  if (cacheCleanupFailed || orphanCleanup.some((result) => result.status === "rejected")) {
    throw new OfflineStorageUnavailableError();
  }
}

async function deleteJournaledCacheEntry(
  db: Awaited<ReturnType<typeof database>>,
  cache: Cache,
  url: string,
): Promise<void> {
  await cache.delete(url);
  await db.delete("cacheEntries", url);
}

async function reconcileOrphanedCacheEntries(
  db: Awaited<ReturnType<typeof database>>,
): Promise<void> {
  const entries = await db.getAll("cacheEntries");
  await Promise.allSettled(
    entries.map((entry) =>
      withMediaWriteLock(offlineBookKey(entry.userId, entry.bookId), async () => {
        const record = await db.get("downloads", offlineBookKey(entry.userId, entry.bookId));
        if (record?.offlineMediaUrl === entry.url || record?.offlineCoverUrl === entry.url) {
          return;
        }
        const cache = await caches.open(MEDIA_CACHE);
        await deleteJournaledCacheEntry(db, cache, entry.url);
      }),
    ),
  );
}

function offlineBookKey(userId: string, bookId: string) {
  return `${userId}:${bookId}`;
}

function isQuotaError(error: unknown) {
  return error instanceof DOMException && error.name === "QuotaExceededError";
}

function offlineStorageError(error: unknown) {
  if (
    error instanceof Error &&
    error.message === "This device does not have enough free storage."
  ) {
    return error;
  }
  if (isQuotaError(error)) return new Error("This device does not have enough free storage.");
  return new Error(
    "This device could not save the audiobook for offline playback. Check available storage and try again.",
    { cause: error },
  );
}
