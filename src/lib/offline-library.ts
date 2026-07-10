import { openDB, type DBSchema } from "idb";

import type { PlayerBook } from "@/domain/player";

const DATABASE_NAME = "chapterline-offline-v1";
const MEDIA_CACHE = "chapterline-media-v1";

export type OfflineBook = {
  key: string;
  userId: string;
  book: Omit<PlayerBook, "mediaUrl" | "coverUrl">;
  offlineMediaUrl: string;
  offlineCoverUrl: string | null;
  byteSize: number;
  downloadedAt: string;
};

interface OfflineDatabase extends DBSchema {
  downloads: {
    key: string;
    value: OfflineBook;
    indexes: { "by-user": string };
  };
}

function database() {
  return openDB<OfflineDatabase>(DATABASE_NAME, 1, {
    upgrade(db) {
      const downloads = db.createObjectStore("downloads", { keyPath: "key" });
      downloads.createIndex("by-user", "userId");
    },
  });
}

export async function listOfflineBooks(userId: string): Promise<OfflineBook[]> {
  const db = await database();
  const records = await db.getAllFromIndex("downloads", "by-user", userId);
  return records.sort((left, right) => right.downloadedAt.localeCompare(left.downloadedAt));
}

export async function getOfflineBook(userId: string, bookId: string) {
  const db = await database();
  return db.get("downloads", offlineBookKey(userId, bookId));
}

export async function removeOfflineBook(userId: string, bookId: string) {
  const db = await database();
  const key = offlineBookKey(userId, bookId);
  const existing = await db.get("downloads", key);
  if (existing) {
    const cache = await caches.open(MEDIA_CACHE);
    await cache.delete(existing.offlineMediaUrl);
    if (existing.offlineCoverUrl) await cache.delete(existing.offlineCoverUrl);
  }
  await db.delete("downloads", key);
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
): Promise<OfflineBook> {
  await ensureStorageCapacity(file.size);
  if (navigator.storage?.persist) await navigator.storage.persist().catch(() => false);

  const token = crypto.randomUUID();
  const offlineMediaUrl = `/offline-media/${token}`;
  const cache = await caches.open(MEDIA_CACHE);
  try {
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
    await cache.delete(offlineMediaUrl);
    if (isQuotaError(error)) throw new Error("This device does not have enough free storage.");
    throw error;
  }

  let offlineCoverUrl: string | null = null;
  if (artwork) {
    try {
      offlineCoverUrl = `/offline-media/${token}-cover`;
      await cache.put(
        offlineCoverUrl,
        new Response(new Blob([artwork.data as BlobPart], { type: artwork.mimeType }), {
          headers: { "Content-Type": artwork.mimeType },
        }),
      );
    } catch {
      offlineCoverUrl = null;
    }
  }

  const existing = await getOfflineBook(userId, book.id);
  const record: OfflineBook = {
    key: offlineBookKey(userId, book.id),
    userId,
    book,
    offlineMediaUrl,
    offlineCoverUrl,
    byteSize: file.size,
    downloadedAt: new Date().toISOString(),
  };

  const db = await database();
  try {
    await db.put("downloads", record);
    if (existing) {
      await cache.delete(existing.offlineMediaUrl);
      if (existing.offlineCoverUrl) await cache.delete(existing.offlineCoverUrl);
    }
    return record;
  } catch (error) {
    await cache.delete(offlineMediaUrl);
    if (offlineCoverUrl) await cache.delete(offlineCoverUrl);
    throw error;
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
  const estimate = await navigator.storage.estimate();
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
  const downloads = await listOfflineBooks(userId).catch(() => []);
  for (const record of downloads) {
    await removeOfflineBook(userId, record.book.id).catch(() => undefined);
  }

  const keysToRemove: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.includes(`:${userId}`)) keysToRemove.push(key);
  }
  keysToRemove.forEach((key) => localStorage.removeItem(key));

  for (const queueKey of ["chapterline:progress-queue", "chapterline:bookmark-queue"]) {
    try {
      const entries = JSON.parse(localStorage.getItem(queueKey) || "[]") as Array<{
        userId?: string;
      }>;
      localStorage.setItem(
        queueKey,
        JSON.stringify(entries.filter((entry) => entry.userId !== userId)),
      );
    } catch {
      localStorage.removeItem(queueKey);
    }
  }
  if (localStorage.getItem("chapterline:active-user") === userId) {
    localStorage.removeItem("chapterline:active-user");
  }
}

function offlineBookKey(userId: string, bookId: string) {
  return `${userId}:${bookId}`;
}

function isQuotaError(error: unknown) {
  return error instanceof DOMException && error.name === "QuotaExceededError";
}
