import { runBounded } from "@/lib/run-bounded";

import {
  database,
  MEDIA_CACHE,
  offlineBookKey,
  withMediaWriteLock,
  type OfflineBook,
  type OfflineDb,
} from "./db";
import { deleteBookTranscript } from "./transcript-store";

const CACHE_DELETE_CONCURRENCY = 8;

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
  const bookId = pending?.bookId || existing?.book.id;
  const userId = pending?.userId || existing?.userId;
  if (bookId && userId) {
    await deleteBookTranscript(db, userId, bookId).catch(() => undefined);
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

/**
 * Bulk variant: bounded cache fan-out and one IndexedDB transaction, so
 * removing a thousand-chunk audiobook does not queue a thousand independent
 * transactions. Journal rows are dropped only for URLs whose cache delete
 * succeeded, preserving the journal-covers-bytes invariant.
 */
export async function deleteJournaledCacheEntries(
  db: OfflineDb,
  cache: Cache,
  urls: string[],
): Promise<void> {
  if (!urls.length) return;
  const removed: string[] = [];
  let failure: unknown;
  let failed = false;
  await runBounded(urls, CACHE_DELETE_CONCURRENCY, async (url) => {
    try {
      await cache.delete(url);
      removed.push(url);
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  });
  if (removed.length) {
    const transaction = db.transaction("cacheEntries", "readwrite");
    await Promise.all([...removed.map((url) => transaction.store.delete(url)), transaction.done]);
  }
  if (failed) throw failure;
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
  await deleteJournaledCacheEntries(db, cache, urls);
}

/**
 * Orphan detection is an in-memory diff of two snapshot reads. Chunked
 * audiobooks put thousands of rows in `cacheEntries`, so per-entry work
 * (a lock or a get per row) would stall every launch for minutes-long books;
 * locks are taken only for the rare books that actually have orphans, and
 * ownership is re-checked under the lock so an import that is still
 * journaling in another tab is never swept.
 */
async function reconcileOrphanedCacheEntries(db: OfflineDb): Promise<void> {
  const [entries, downloads] = await Promise.all([
    db.getAll("cacheEntries"),
    db.getAll("downloads"),
  ]);
  const owned = ownedUrls(downloads);
  const orphansByBook = new Map<string, string[]>();
  for (const entry of entries) {
    if (owned.has(ownershipUrl(entry.url))) continue;
    const key = offlineBookKey(entry.userId, entry.bookId);
    const group = orphansByBook.get(key);
    if (group) group.push(entry.url);
    else orphansByBook.set(key, [entry.url]);
  }
  if (!orphansByBook.size) return;
  const cache = await caches.open(MEDIA_CACHE);
  await Promise.allSettled(
    [...orphansByBook.entries()].map(([key, urls]) =>
      withMediaWriteLock(key, async () => {
        const record = await db.get("downloads", key);
        const currentlyOwned = ownedUrls(record ? [record] : []);
        await deleteJournaledCacheEntries(
          db,
          cache,
          urls.filter((url) => !currentlyOwned.has(ownershipUrl(url))),
        );
      }),
    ),
  );
}

function ownedUrls(records: OfflineBook[]): Set<string> {
  const owned = new Set<string>();
  for (const record of records) {
    owned.add(record.offlineMediaUrl);
    if (record.offlineCoverUrl) owned.add(record.offlineCoverUrl);
    if (record.offlineCoverThumbUrl) owned.add(record.offlineCoverThumbUrl);
  }
  return owned;
}

/** Chunk URLs (`…/chunk/N`) are owned through their book's media URL. */
function ownershipUrl(url: string): string {
  const index = url.indexOf("/chunk/");
  return index === -1 ? url : url.slice(0, index);
}
