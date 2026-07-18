import type { PlayerBook } from "@/domain/player";
import { createCoverThumbnail } from "@/lib/cover-thumbnail";
import { runBounded } from "@/lib/run-bounded";

import { database, MEDIA_CACHE, offlineBookKey, withMediaWriteLock, type OfflineBook } from "./db";
import {
  deleteJournaledCacheEntries,
  deleteJournaledCacheEntry,
  deleteJournaledMedia,
} from "./deletion-journal";
import { getOfflineBook } from "./library";

const MEDIA_CHUNK_BYTES = 4 * 1024 * 1024;
// Overlaps file reads with cache commits while keeping at most ~12MB of audio
// in flight, well inside iOS WebKit's memory budget.
const MEDIA_WRITE_CONCURRENCY = 3;

/**
 * Stores an imported MP3 in bounded chunks. iOS WebKit has a much smaller
 * memory budget than desktop browsers, so neither import nor a later Range
 * request may materialize a whole audiobook-sized Blob.
 */
export async function storeLocalBookMedia(
  userId: string,
  book: Omit<PlayerBook, "mediaUrl" | "coverUrl">,
  file: File,
  artwork: { data: Uint8Array; mimeType: string } | null,
  onProgress?: (fraction: number) => void,
): Promise<OfflineBook> {
  const key = offlineBookKey(userId, book.id);
  const startedAt = Date.now();
  return withMediaWriteLock(key, async () => {
    const pending = await (await database()).get("deletions", key);
    if (pending?.completedAt && pending.completedAt >= startedAt) {
      throw new Error("This download was removed while it was being saved.");
    }
    return storeLocalBookMediaUnlocked(userId, book, file, artwork, onProgress);
  });
}

async function storeLocalBookMediaUnlocked(
  userId: string,
  book: Omit<PlayerBook, "mediaUrl" | "coverUrl">,
  file: File,
  artwork: { data: Uint8Array; mimeType: string } | null,
  onProgress?: (fraction: number) => void,
): Promise<OfflineBook> {
  await ensureStorageCapacity(file.size);
  if (navigator.storage?.persist) await navigator.storage.persist().catch(() => false);

  const token = crypto.randomUUID();
  const offlineMediaUrl = `/offline-media/${token}`;
  const key = offlineBookKey(userId, book.id);
  const db = await database();
  const chunkCount = Math.ceil(file.size / MEDIA_CHUNK_BYTES);
  const chunkUrls = Array.from(
    { length: chunkCount },
    (_, index) => `${offlineMediaUrl}/chunk/${index}`,
  );
  const cleanupUrls: string[] = [...chunkUrls, offlineMediaUrl];
  let cache: Cache | undefined;
  try {
    // Journal rows for every chunk land in one transaction before any bytes
    // move: the journal-before-bytes invariant is unchanged, but a
    // thousand-chunk audiobook costs one IndexedDB commit instead of one per
    // chunk.
    const journal = db.transaction("cacheEntries", "readwrite");
    await Promise.all([
      ...cleanupUrls.map((url) => journal.store.put({ url, userId, bookId: book.id })),
      journal.done,
    ]);
    cache = await caches.open(MEDIA_CACHE);
    let storedChunks = 0;
    let writeFailed = false;
    let writeFailure: unknown;
    // Workers swallow their own failure and drain, so no chunk write is still
    // in flight when cleanup below starts deleting what they wrote.
    await runBounded(
      Array.from({ length: chunkCount }, (_, index) => index),
      MEDIA_WRITE_CONCURRENCY,
      async (index) => {
        if (writeFailed) return;
        try {
          await cache!.put(
            chunkUrls[index]!,
            new Response(
              file.slice(
                index * MEDIA_CHUNK_BYTES,
                Math.min(file.size, (index + 1) * MEDIA_CHUNK_BYTES),
              ),
              { headers: { "Content-Type": "application/octet-stream" } },
            ),
          );
        } catch (error) {
          if (!writeFailed) {
            writeFailed = true;
            writeFailure = error;
          }
          return;
        }
        storedChunks += 1;
        onProgress?.(storedChunks / (chunkCount + 1));
      },
    );
    if (writeFailed) throw writeFailure;
    await cache.put(
      offlineMediaUrl,
      new Response(
        JSON.stringify({
          format: "chapterline-chunked-media-v1",
          byteSize: file.size,
          chunkSize: MEDIA_CHUNK_BYTES,
          chunkCount,
        }),
        {
          headers: {
            "Content-Type": "application/vnd.chapterline.media+json",
            "X-Chapterline-Media-Format": "chunked-v1",
          },
        },
      ),
    );
    onProgress?.(1);
  } catch (error) {
    if (cache) {
      await deleteJournaledCacheEntries(db, cache, cleanupUrls).catch(() => undefined);
    } else {
      await Promise.allSettled(cleanupUrls.map((url) => db.delete("cacheEntries", url)));
    }
    throw offlineStorageError(error);
  }

  let offlineCoverUrl: string | null = null;
  let offlineCoverThumbUrl: string | null = null;
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
      const thumbnail = await createCoverThumbnail(artwork.data, artwork.mimeType);
      if (thumbnail) {
        offlineCoverThumbUrl = `${offlineCoverUrl}-thumb`;
        await db.put("cacheEntries", { url: offlineCoverThumbUrl, userId, bookId: book.id });
        await cache.put(
          offlineCoverThumbUrl,
          new Response(thumbnail.data, { headers: { "Content-Type": thumbnail.mimeType } }),
        );
      }
    } catch {
      for (const url of [offlineCoverThumbUrl, offlineCoverUrl]) {
        if (url) await deleteJournaledCacheEntry(db, cache, url).catch(() => false);
      }
      offlineCoverUrl = null;
      offlineCoverThumbUrl = null;
    }
  }

  const record: OfflineBook = {
    key,
    userId,
    book,
    offlineMediaUrl,
    offlineCoverUrl,
    offlineCoverThumbUrl,
    byteSize: file.size,
    downloadedAt: new Date().toISOString(),
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
      await deleteJournaledMedia(db, cache, existing.offlineMediaUrl).catch(() => false);
      for (const url of [existing.offlineCoverUrl, existing.offlineCoverThumbUrl]) {
        if (url) await deleteJournaledCacheEntry(db, cache, url).catch(() => false);
      }
    }
    return record;
  } catch (error) {
    const current = await db.get("downloads", key).catch(() => undefined);
    if (current?.offlineMediaUrl === offlineMediaUrl) {
      if (existing) await db.put("downloads", existing).catch(() => undefined);
      else await db.delete("downloads", key).catch(() => undefined);
    }
    await deleteJournaledMedia(db, cache, offlineMediaUrl).catch(() => false);
    for (const url of [offlineCoverUrl, offlineCoverThumbUrl]) {
      if (url) await deleteJournaledCacheEntry(db, cache, url).catch(() => false);
    }
    throw offlineStorageError(error);
  }
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
