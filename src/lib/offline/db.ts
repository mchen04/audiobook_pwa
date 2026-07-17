import { openDB, type DBSchema } from "idb";

import type { PlayerBook } from "@/domain/player";
import { withKeyedLock } from "@/lib/keyed-lock";

const DATABASE_NAME = "chapterline-offline-v1";
export const MEDIA_CACHE = "chapterline-media-v2";

export type OfflineBook = {
  key: string;
  userId: string;
  book: Omit<PlayerBook, "mediaUrl" | "coverUrl" | "coverThumbUrl">;
  offlineMediaUrl: string;
  offlineCoverUrl: string | null;
  /** Absent on records stored before thumbnails existed. */
  offlineCoverThumbUrl?: string | null;
  byteSize: number;
  downloadedAt: string;
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
      offlineCoverThumbUrl?: string | null;
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

export type OfflineDb = Awaited<ReturnType<typeof database>>;

export function database() {
  return openDB<OfflineDatabase>(DATABASE_NAME, 5, {
    upgrade(db, oldVersion, _newVersion, transaction) {
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
      if (oldVersion >= 1 && oldVersion < 5) {
        const downloads = transaction.objectStore("downloads");
        void downloads.openCursor().then(async function removeLegacyBookmarks(cursor) {
          if (!cursor) return;
          const record = cursor.value as OfflineBook & { bookmarks?: unknown };
          if ("bookmarks" in record) {
            const { bookmarks, ...clean } = record;
            void bookmarks;
            await cursor.update(clean);
          }
          await removeLegacyBookmarks(await cursor.continue());
        });
      }
    },
  });
}

export function offlineBookKey(userId: string, bookId: string) {
  return `${userId}:${bookId}`;
}

export function withMediaWriteLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  return withKeyedLock(`chapterline-media:${key}`, operation);
}
