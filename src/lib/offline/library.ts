import type { PlayerBook } from "@/domain/player";
import { ACTIVE_USER_KEY } from "@/lib/app-keys";
import { clearQueuedMutationsForUser } from "@/lib/offline-sync";

import {
  database,
  MEDIA_CACHE,
  offlineBookKey,
  OfflineStorageUnavailableError,
  withMediaWriteLock,
  type OfflineBook,
  type OfflineDb,
} from "./db";
import {
  deleteJournaledCacheEntry,
  deleteJournaledMedia,
  removeOfflineBook,
  retryPendingOfflineDeletions,
} from "./deletion-journal";

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

/**
 * Light read for library cover art: one indexed lookup, no deletion retry and
 * no cache reconcile, so callers can refresh per keystroke without cost.
 */
export async function listOfflineCoverUrls(userId: string): Promise<Record<string, string>> {
  const covers: Record<string, string> = {};
  for (const record of await listStoredOfflineBooks(userId)) {
    const url = record.offlineCoverThumbUrl || record.offlineCoverUrl;
    if (url) covers[record.book.id] = url;
  }
  return covers;
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

async function reconcileOfflineRecord(db: OfflineDb, cache: Cache, record: OfflineBook) {
  if (await cache.match(record.offlineMediaUrl)) return record;
  for (const url of [record.offlineCoverUrl, record.offlineCoverThumbUrl]) {
    if (url) await deleteJournaledCacheEntry(db, cache, url).catch(() => false);
  }
  await deleteJournaledMedia(db, cache, record.offlineMediaUrl).catch(() => false);
  await db.delete("downloads", record.key);
  return undefined;
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

export function asOfflinePlayerBook(record: OfflineBook): PlayerBook {
  return {
    ...record.book,
    mediaUrl: record.offlineMediaUrl,
    coverUrl: record.offlineCoverUrl,
    coverThumbUrl: record.offlineCoverThumbUrl || record.offlineCoverUrl,
  };
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
  const { clearPlaybackHistoryForUser } = await import("@/lib/playback-history");
  await clearPlaybackHistoryForUser(userId);
  if (localStorage.getItem(ACTIVE_USER_KEY) === userId) {
    localStorage.removeItem(ACTIVE_USER_KEY);
  }
  if (cacheCleanupFailed || orphanCleanup.some((result) => result.status === "rejected")) {
    throw new OfflineStorageUnavailableError();
  }
}
