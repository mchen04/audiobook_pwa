import { database, MEDIA_CACHE, offlineBookKey, withMediaWriteLock, type OfflineDb } from "./db";

/**
 * Deletions are journaled before any bytes are removed so a crash mid-delete
 * leaves a retryable record instead of orphaned cache entries.
 */
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
      offlineCoverThumbUrl: existing?.offlineCoverThumbUrl,
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

async function completeOfflineDeletion(db: OfflineDb, key: string): Promise<void> {
  const pending = await db.get("deletions", key);
  const existing = await db.get("downloads", key);
  const mediaUrl = pending?.offlineMediaUrl || existing?.offlineMediaUrl;
  const coverUrl = pending?.offlineCoverUrl || existing?.offlineCoverUrl;
  const coverThumbUrl = pending?.offlineCoverThumbUrl || existing?.offlineCoverThumbUrl;
  if (mediaUrl) {
    const cache = await caches.open(MEDIA_CACHE);
    await deleteJournaledMedia(db, cache, mediaUrl);
    if (coverUrl) await deleteJournaledCacheEntry(db, cache, coverUrl);
    if (coverThumbUrl) await deleteJournaledCacheEntry(db, cache, coverThumbUrl);
  }
  await db.delete("downloads", key);
  if (pending) {
    await db.put("deletions", {
      ...pending,
      offlineMediaUrl: undefined,
      offlineCoverUrl: undefined,
      offlineCoverThumbUrl: undefined,
      completedAt: Date.now(),
    });
  }
}

export async function deleteJournaledCacheEntry(
  db: OfflineDb,
  cache: Cache,
  url: string,
): Promise<void> {
  await cache.delete(url);
  await db.delete("cacheEntries", url);
}

export async function deleteJournaledMedia(
  db: OfflineDb,
  cache: Cache,
  mediaUrl: string,
): Promise<void> {
  // The store is keyed by URL, so the chunk list is a key-range read instead
  // of a scan across every stored book.
  const chunkPrefix = `${mediaUrl}/chunk/`;
  const urls = await db.getAllKeys(
    "cacheEntries",
    IDBKeyRange.bound(chunkPrefix, `${chunkPrefix}\uffff`),
  );
  urls.push(mediaUrl);
  const results = await Promise.allSettled(
    urls.map((url) => deleteJournaledCacheEntry(db, cache, url)),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

async function reconcileOrphanedCacheEntries(db: OfflineDb): Promise<void> {
  const entries = await db.getAll("cacheEntries");
  await Promise.allSettled(
    entries.map((entry) =>
      withMediaWriteLock(offlineBookKey(entry.userId, entry.bookId), async () => {
        const record = await db.get("downloads", offlineBookKey(entry.userId, entry.bookId));
        if (
          record?.offlineMediaUrl === entry.url ||
          entry.url.startsWith(`${record?.offlineMediaUrl}/chunk/`) ||
          record?.offlineCoverUrl === entry.url ||
          record?.offlineCoverThumbUrl === entry.url
        ) {
          return;
        }
        const cache = await caches.open(MEDIA_CACHE);
        await deleteJournaledCacheEntry(db, cache, entry.url);
      }),
    ),
  );
}
