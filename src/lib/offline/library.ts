import type { PlayerBook } from "@/domain/player";
import { ACTIVE_USER_KEY } from "@/lib/app-keys";
import { clearQueuedMutationsForUser } from "@/lib/offline-sync";

import {
  database,
  MEDIA_CACHE,
  mirrorChapterKey,
  mirrorPrefixRange,
  offlineBookKey,
  OfflineStorageUnavailableError,
  withMediaWriteLock,
  type OfflineBook,
  type OfflineDb,
} from "./db";
import {
  deleteJournaledCacheEntries,
  removeOfflineBook,
  retryPendingOfflineDeletions,
} from "./deletion-journal";
import { deleteAllTranscriptsForUser } from "./transcript-store";

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

/**
 * The raw download records for one account: one indexed lookup, no deletion
 * retry and no Cache Storage reconcile. The library reads this on the paint
 * path; `listOfflineBooks` does the reconciling read afterwards.
 */
export async function listStoredOfflineBooks(userId: string): Promise<OfflineBook[]> {
  const db = await database();
  return db.getAllFromIndex("downloads", "by-user", userId);
}

/**
 * One download record exactly as stored — no deletion retry, no reconcile, no
 * Cache Storage read at all.
 *
 * `getOfflineBook` answers a different question ("can this device play it
 * right now?") and deliberately returns `undefined` for a book whose audio is
 * missing. A caller that needs the ROW — to reclaim the bytes the old token
 * owned, or to put it back after a failed write — has to ask for the row.
 */
export async function getStoredOfflineBook(
  userId: string,
  bookId: string,
): Promise<OfflineBook | undefined> {
  const db = await database();
  return db.get("downloads", offlineBookKey(userId, bookId));
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

/**
 * Answers one question — can this device play this book right now? — and
 * records the answer. It DESTROYS NOTHING.
 *
 * It used to. A single missed `cache.match` deleted the download record, its
 * journaled cache rows and the book's read-along cues, on a path that runs on
 * every `/library` visit and every player open. WebKit was then measured
 * discarding every Cache Storage *record* for this origin while the cache
 * *names* survived — a heal restored and verified 33 shell and 6 media entries,
 * and seconds later both caches read zero from two pages at once. So
 * `caches.open` resolves, every `match` misses, and the app destroyed the
 * user's downloads and read-along data on the next launch. Putting the bytes
 * back afterwards restores neither.
 *
 * A failed read is not proof of permanent loss, so it is not treated as one:
 *
 * - `undefined` still comes back, which is the ONLY thing the callers ever
 *   needed. `local-media-gate.tsx` turns it into the "this device does not
 *   currently have it — attach the original MP3" screen, and
 *   `listOfflineBooks` drops the book from the playable set. That is already
 *   the correct destination for a book whose bytes are missing.
 * - `offlineMediaUrl` and its `cacheEntries` rows stay, so bytes that come back
 *   are still owned and still reachable rather than swept as orphans.
 * - The transcript stays. It is keyed by book id and was never addressed by the
 *   token that missed; losing read-along data because an audio blob was evicted
 *   is gratuitous.
 * - The record is marked instead, and unmarked as soon as a `match` succeeds.
 *
 * Deletion still happens where it is correct and nowhere else: `removeOfflineBook`
 * (explicit user delete, and the library's remove-download), `clearLocalDataForUser`
 * and `purgeAccount`. None of them route through here.
 */
async function reconcileOfflineRecord(db: OfflineDb, cache: Cache, record: OfflineBook) {
  if (await cache.match(record.offlineMediaUrl)) {
    if (!record.mediaMissingSince) return record;
    await setMediaMissingSince(db, record, null);
    return { ...record, mediaMissingSince: null };
  }
  if (!record.mediaMissingSince) {
    await setMediaMissingSince(db, record, new Date().toISOString());
  }
  return undefined;
}

/**
 * Stamps the observation on the stored record, in one transaction, and only
 * while the record still points at the token that was looked up. An import
 * mints a fresh token and writes a fresh record, so that check is what stops a
 * reconcile racing an attach from marking audio that has just arrived.
 */
async function setMediaMissingSince(
  db: OfflineDb,
  record: OfflineBook,
  mediaMissingSince: string | null,
): Promise<void> {
  const transaction = db.transaction("downloads", "readwrite");
  const current = await transaction.store.get(record.key);
  if (
    current &&
    current.offlineMediaUrl === record.offlineMediaUrl &&
    (current.mediaMissingSince ?? null) !== mediaMissingSince
  ) {
    await transaction.store.put({ ...current, mediaMissingSince });
  }
  await transaction.done;
}

/**
 * Re-points this device's copy of a book from the id it was imported under to
 * the id the server settled on. Not one audio byte moves.
 *
 * An import queued while the network was down carries an id this device minted,
 * and the bytes, the download record, the cache journal and the read-along cues
 * are all written under it. When that registration finally replays and the
 * server answers 409 — this fingerprint already belongs to book Y — the audio on
 * this device is filed under a name no pull will ever mention: a second copy of
 * the same audiobook, playable here and invisible everywhere else, next to a
 * book Y that asks the user to re-import a file they already imported. Design
 * contract section 10 promises that re-import is lossless and creates no
 * duplicate; this is that promise on the offline path.
 *
 * What moves is the IDENTITY, never the data:
 *
 * - `offlineMediaUrl` is a random token minted at store time and kept on the
 *   record. Nothing derives it from the book id — `media-store.ts` mints it,
 *   `local-media-gate.tsx` and `asOfflinePlayerBook` read it back — so
 *   re-pointing the record leaves every chunk in Cache Storage exactly where it
 *   is. That is the only tolerable shape here: a book can be a 600-hour MP3 and
 *   copying it to rename it would risk `QuotaExceededError` while destroying
 *   the one copy of data that exists nowhere else in the world (section 1).
 * - `cacheEntries.bookId` and the transcript keys travel with it, so the
 *   eviction sweep and the account purge still find the rows they own.
 *
 * Interruption-safe by construction. The move is ONE IndexedDB transaction
 * across the three stores, so it either happened or did not; either way the
 * queued registration is only settled after this returns, and a replay that
 * runs again gets the same deterministic 409 and the same canonical id. Running
 * it twice is a no-op.
 */
export async function reattachLocalBookIdentity(
  userId: string,
  fromBookId: string,
  toBookId: string,
  canonical: unknown = null,
): Promise<void> {
  if (!fromBookId || !toBookId || fromBookId === toBookId) return;
  const db = await database();
  const fromKey = offlineBookKey(userId, fromBookId);
  const toKey = offlineBookKey(userId, toBookId);

  // Exactly one lock is taken, and it is the SOURCE's. The import holds that
  // same lock across its whole local write (`media-store.ts#withLocalMediaSlot`),
  // so waiting for it is what stops a replay from moving a book whose bytes are
  // still being written. A second lock on the target is deliberately not taken:
  // an import that reattached online holds the source's slot and then asks for
  // the target's, so a reattach that took them in the other order could deadlock
  // against it. The target needs no lock — the move below is one atomic
  // transaction, and a writer that loses that race leaves URLs no record owns,
  // which `retryAllPendingOfflineDeletions` already sweeps.
  const journaled = await withMediaWriteLock(fromKey, async () => {
    const [record, target] = await Promise.all([
      db.get("downloads", fromKey),
      db.get("downloads", toKey),
    ]);
    if (record && target && (await mediaIsStored(target.offlineMediaUrl))) {
      // The canonical id already holds these exact bytes — the server proved
      // that by rejecting the registration on the fingerprint. The source is a
      // redundant second copy of a file that is still on this device, so it is
      // journaled for deletion first and removed after, never the other way
      // round.
      await db.put("deletions", {
        key: fromKey,
        userId,
        bookId: fromBookId,
        offlineMediaUrl: record.offlineMediaUrl,
        offlineCoverUrl: record.offlineCoverUrl,
        offlineCoverThumbUrl: record.offlineCoverThumbUrl,
      });
      await db.delete("downloads", fromKey);
      return true;
    }
    await rekeyLocalBook(db, userId, fromBookId, toBookId, toCanonicalBook(canonical));
    return false;
  });
  // Outside the lock: the journal takes it again for every entry it completes.
  // A failure here is not a failed merge — the download record is already gone
  // and the journal row is what owns those bytes now, exactly as it does for
  // any other interrupted deletion.
  if (journaled) await retryPendingOfflineDeletions(userId).catch(() => undefined);
}

async function mediaIsStored(offlineMediaUrl: string): Promise<boolean> {
  const cache = await caches.open(MEDIA_CACHE);
  return !!(await cache.match(offlineMediaUrl));
}

/**
 * The whole move, in one transaction over the three stores that name a book by
 * id. Cache Storage is not opened here at all, which is the point: the bytes
 * are addressed by a token this function never reads.
 */
async function rekeyLocalBook(
  db: OfflineDb,
  userId: string,
  fromBookId: string,
  toBookId: string,
  canonical: OfflineBook["book"] | null,
): Promise<void> {
  const fromKey = offlineBookKey(userId, fromBookId);
  const toKey = offlineBookKey(userId, toBookId);
  const transaction = db.transaction(["downloads", "cacheEntries", "transcripts"], "readwrite");
  const downloads = transaction.objectStore("downloads");
  const entries = transaction.objectStore("cacheEntries");
  const transcripts = transaction.objectStore("transcripts");

  const [record, cacheRows, cues, targetCueKeys] = await Promise.all([
    downloads.get(fromKey),
    entries.index("by-user").getAll(userId),
    transcripts.getAll(mirrorPrefixRange(userId, fromBookId)),
    transcripts.getAllKeys(mirrorPrefixRange(userId, toBookId)),
  ]);

  const writes: Promise<unknown>[] = [];
  if (record) {
    writes.push(
      downloads.put({
        ...record,
        key: toKey,
        // The id is the key's own tail, never the payload's: a record whose
        // `book.id` disagreed with the row it is filed under would be a book
        // the gate can find and the library cannot, or the reverse.
        book: canonical ? { ...canonical, id: toBookId } : renameBook(record.book, toBookId),
      }),
      downloads.delete(fromKey),
    );
  }
  for (const row of cacheRows) {
    if (row.bookId === fromBookId) writes.push(entries.put({ ...row, bookId: toBookId }));
  }
  for (const cue of cues) {
    writes.push(transcripts.delete(cue.key));
    // Cues already filed under the canonical id came from this same file — the
    // server matched the fingerprint — so the source's copy is dropped rather
    // than written over them.
    if (!targetCueKeys.length) {
      writes.push(
        transcripts.put({
          ...cue,
          key: mirrorChapterKey(userId, toBookId, cue.chapterIndex),
          bookId: toBookId,
        }),
      );
    }
  }
  await Promise.all([...writes, transaction.done]);
}

/** The record's own metadata, with every id that named the old book replaced. */
function renameBook(book: OfflineBook["book"], bookId: string): OfflineBook["book"] {
  return {
    ...book,
    id: bookId,
    chapters: book.chapters.map((chapter) => ({ ...chapter, id: `${bookId}:${chapter.position}` })),
  };
}

/**
 * The `playerBook` a 409 carries, when it carries one: the canonical title,
 * chapters and saved position, which is what the online reattach in
 * `local-import.ts` stores. Anything unrecognisable is ignored rather than
 * trusted — the record it would replace is the only local description of a file
 * the server does not have.
 */
function toCanonicalBook(value: unknown): OfflineBook["book"] | null {
  if (!value || typeof value !== "object") return null;
  const book = value as Partial<PlayerBook>;
  if (typeof book.id !== "string" || !book.id) return null;
  if (typeof book.title !== "string" || typeof book.author !== "string") return null;
  if (typeof book.durationMs !== "number" || !Array.isArray(book.chapters)) return null;
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    durationMs: book.durationMs,
    chapters: book.chapters,
    initialPositionMs: Number(book.initialPositionMs) || 0,
    initialProgressOccurredAt:
      typeof book.initialProgressOccurredAt === "string" ? book.initialProgressOccurredAt : null,
    initialPlaybackRate: Number(book.initialPlaybackRate) || 1,
    completed: !!book.completed,
  };
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
  // Grouped per book so a chunked audiobook takes one lock and one batched
  // delete instead of thousands of per-chunk lock acquisitions.
  const orphansByBook = new Map<string, string[]>();
  for (const entry of orphaned) {
    const group = orphansByBook.get(entry.bookId);
    if (group) group.push(entry.url);
    else orphansByBook.set(entry.bookId, [entry.url]);
  }
  const orphanCleanup = await Promise.allSettled(
    [...orphansByBook.entries()].map(([bookId, urls]) =>
      withMediaWriteLock(offlineBookKey(userId, bookId), async () => {
        const cache = await caches.open(MEDIA_CACHE);
        await deleteJournaledCacheEntries(db, cache, urls);
      }),
    ),
  );

  const keysToRemove: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.includes(`:${userId}`)) keysToRemove.push(key);
  }
  keysToRemove.forEach((key) => localStorage.removeItem(key));

  await deleteAllTranscriptsForUser(userId).catch(() => undefined);
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
