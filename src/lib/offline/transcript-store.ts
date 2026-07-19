import type { BookTranscript } from "@/domain/transcript";

import { database, type OfflineDb, type StoredChapterTranscript } from "./db";

/**
 * Read-along cues live only in this device's IndexedDB, alongside the audio.
 * They are chapter-keyed so the player loads one chapter's cues at a time,
 * and they never appear in any server request.
 */

function chapterKey(userId: string, bookId: string, chapterIndex: number) {
  // Zero-padded so lexicographic key ranges enumerate chapters in order.
  return `${userId}:${bookId}:${String(chapterIndex).padStart(6, "0")}`;
}

function bookRange(userId: string, bookId: string) {
  const prefix = `${userId}:${bookId}:`;
  return IDBKeyRange.bound(prefix, `${prefix}￿`);
}

export async function storeBookTranscript(
  userId: string,
  bookId: string,
  transcript: BookTranscript,
): Promise<void> {
  const db = await database();
  const transaction = db.transaction("transcripts", "readwrite");
  let cursor = await transaction.store.openCursor(bookRange(userId, bookId));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  for (const chapter of transcript.chapters) {
    await transaction.store.put({
      key: chapterKey(userId, bookId, chapter.index),
      userId,
      bookId,
      chapterIndex: chapter.index,
      granularity: chapter.granularity,
      sentences: chapter.sentences,
    });
  }
  await transaction.done;
}

/** Chapter indexes that have cues; empty array = book has no read-along. */
export async function getTranscriptChapterIndexes(
  userId: string,
  bookId: string,
): Promise<number[]> {
  const db = await database();
  const records = await db.getAll("transcripts", bookRange(userId, bookId));
  return records.map((record) => record.chapterIndex);
}

export async function getChapterTranscript(
  userId: string,
  bookId: string,
  chapterIndex: number,
): Promise<StoredChapterTranscript | undefined> {
  const db = await database();
  return db.get("transcripts", chapterKey(userId, bookId, chapterIndex));
}

/** Used by the deletion journal; accepts its transaction-owning db handle. */
export async function deleteBookTranscript(
  db: OfflineDb,
  userId: string,
  bookId: string,
): Promise<void> {
  const keys = await db.getAllKeys("transcripts", bookRange(userId, bookId));
  if (!keys.length) return;
  const transaction = db.transaction("transcripts", "readwrite");
  await Promise.all([...keys.map((key) => transaction.store.delete(key)), transaction.done]);
}

export async function deleteAllTranscriptsForUser(userId: string): Promise<void> {
  const db = await database();
  const keys = await db.getAllKeysFromIndex("transcripts", "by-user", userId);
  if (!keys.length) return;
  const transaction = db.transaction("transcripts", "readwrite");
  await Promise.all([...keys.map((key) => transaction.store.delete(key)), transaction.done]);
}
