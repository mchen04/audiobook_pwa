import type { IDBPTransaction } from "idb";

import type { LibraryBook } from "@/domain/library";

import {
  database,
  mirrorChapterKey,
  mirrorKey,
  mirrorKeyTail,
  mirrorPrefixRange,
  type MirrorBook,
  type MirrorBookTag,
  type MirrorChapter,
  type MirrorCollection,
  type MirrorCollectionBook,
  type MirrorListeningSession,
  type MirrorPlaybackState,
  type MirrorSyncMeta,
  type MirrorTag,
  type OfflineDatabase,
} from "./db";
import type { PullBatch, PulledBook } from "./sync-protocol";

/**
 * The device-authoritative copy of the library.
 *
 * A pulled batch lands as one IndexedDB transaction across every affected
 * store, and the new pull cursor is part of that same commit. That is the
 * strongest form of "advance the cursor only after the batch is committed":
 * the cursor can never be observed ahead of the data it describes, so an
 * interrupted pull re-fetches and never skips.
 *
 * Reads never touch the network — they are the library UI's only source.
 */

type MirrorStoreName =
  | "books"
  | "chapters"
  | "playbackStates"
  | "tags"
  | "bookTags"
  | "collections"
  | "collectionBooks"
  | "preferences"
  | "listeningSessions"
  | "syncMeta";

const MIRROR_STORES: MirrorStoreName[] = [
  "books",
  "chapters",
  "playbackStates",
  "tags",
  "bookTags",
  "collections",
  "collectionBooks",
  "preferences",
  "listeningSessions",
  "syncMeta",
];

type MirrorTransaction = IDBPTransaction<OfflineDatabase, MirrorStoreName[], "readwrite">;

/** Mirrors `LibrarySort` in `server/books/library-cursor.ts`; the same four orders. */
export type MirrorSort = "activity" | "added" | "title" | "author";
export type MirrorStatus = "all" | "in-progress" | "not-started" | "finished" | "archived";

export type MirrorLibraryQuery = {
  query?: string;
  status?: MirrorStatus;
  tag?: string;
  sort?: MirrorSort;
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Applies one pulled batch. Either all of it lands — aggregates, tombstones
 * and the new cursor — or none of it does.
 */
export async function applyPullBatch(userId: string, batch: PullBatch): Promise<void> {
  const db = await database();
  const transaction = db.transaction(MIRROR_STORES, "readwrite");

  // A failing IndexedDB request aborts the transaction on its own, but a
  // JavaScript throw between two requests — a malformed row that will not
  // structured-clone, say — would otherwise let everything written so far
  // commit. Aborting explicitly is what makes "all of it or none of it" true
  // for both failure modes.
  try {
    await clearBookAggregates(transaction, userId, batch.books);
    await writeBookAggregates(transaction, userId, batch.books);
    await writePlaybackStates(transaction, userId, batch);
    await replaceTags(transaction, userId, batch);
    await replaceCollections(transaction, userId, batch);
    await writePreferences(transaction, userId, batch);
    await writeListeningSessions(transaction, userId, batch);
    await applyTombstones(transaction, userId, batch);

    const meta: MirrorSyncMeta = {
      userId,
      cursor: batch.cursor,
      lastSyncedAt: new Date().toISOString(),
    };
    await transaction.objectStore("syncMeta").put(meta);

    await transaction.done;
  } catch (error) {
    abortQuietly(transaction);
    throw error;
  }
}

function abortQuietly(transaction: MirrorTransaction): void {
  // The caller already holds the real error, so `done`'s AbortError is noise —
  // but an unclaimed rejection would surface as an unhandled one.
  void transaction.done.catch(() => undefined);
  try {
    transaction.abort();
  } catch {
    // A failing request already aborted it; same outcome.
  }
}

/**
 * Each aggregate is replaced wholesale: a chapter or tag edge removed
 * server-side carries no tombstone of its own, and the parent's bumped
 * `updatedAt` is what conveys the change (design contract section 3). The
 * clear is scoped to one book's key range, which is what makes this
 * replacement rather than absence-as-deletion.
 */
async function clearBookAggregates(
  transaction: MirrorTransaction,
  userId: string,
  books: PulledBook[],
): Promise<void> {
  const chapters = transaction.objectStore("chapters");
  const bookTags = transaction.objectStore("bookTags");
  await Promise.all(
    books.flatMap((book) => [
      chapters.delete(mirrorPrefixRange(userId, book.id)),
      bookTags.delete(mirrorPrefixRange(userId, book.id)),
    ]),
  );
}

async function writeBookAggregates(
  transaction: MirrorTransaction,
  userId: string,
  books: PulledBook[],
): Promise<void> {
  const store = transaction.objectStore("books");
  const chapters = transaction.objectStore("chapters");
  const bookTags = transaction.objectStore("bookTags");
  await Promise.all(
    books.flatMap((book) => {
      const record: MirrorBook = {
        key: mirrorKey(userId, book.id),
        userId,
        bookId: book.id,
        title: book.title,
        author: book.author,
        narrator: book.narrator,
        description: book.description,
        series: book.series,
        seriesPosition: book.seriesPosition,
        chapterDiagnostic: book.chapterDiagnostic,
        archivedAt: book.archivedAt,
        createdAt: book.createdAt,
        updatedAt: book.updatedAt,
        media: book.media,
        searchText: searchTextFor(book),
      };
      const chapterRows: MirrorChapter[] = book.chapters.map((chapter) => ({
        key: mirrorChapterKey(userId, book.id, chapter.position),
        userId,
        bookId: book.id,
        position: chapter.position,
        title: chapter.title,
        startMs: chapter.startMs,
        endMs: chapter.endMs,
      }));
      const edgeRows: MirrorBookTag[] = book.tagIds.map((tagId) => ({
        key: mirrorKey(userId, book.id, tagId),
        userId,
        bookId: book.id,
        tagId,
      }));
      return [
        store.put(record),
        ...chapterRows.map((chapter) => chapters.put(chapter)),
        ...edgeRows.map((edge) => bookTags.put(edge)),
      ];
    }),
  );
}

/** Matches the server's `title || ' ' || author || ' ' || narrator || ' ' || series`. */
function searchTextFor(book: PulledBook): string {
  return [book.title, book.author, book.narrator || "", book.series || ""].join(" ").toLowerCase();
}

async function writePlaybackStates(
  transaction: MirrorTransaction,
  userId: string,
  batch: PullBatch,
): Promise<void> {
  const store = transaction.objectStore("playbackStates");
  await Promise.all(
    batch.playbackStates.map((state) => {
      const record: MirrorPlaybackState = {
        key: mirrorKey(userId, state.bookId),
        userId,
        bookId: state.bookId,
        positionMs: state.positionMs,
        playbackRate: state.playbackRate,
        completed: state.completed,
        deviceId: state.deviceId,
        deviceSequence: state.deviceSequence,
        eventOccurredAt: state.eventOccurredAt,
        updatedAt: state.updatedAt,
      };
      return store.put(record);
    }),
  );
}

/**
 * The tag vocabulary is small, user-level and pulled in full, so the batch is
 * the complete truth and a tag it omits is genuinely gone. This is not
 * absence-in-a-page: there are no pages here.
 */
async function replaceTags(
  transaction: MirrorTransaction,
  userId: string,
  batch: PullBatch,
): Promise<void> {
  const store = transaction.objectStore("tags");
  const existing = await store.index("by-user").getAllKeys(userId);
  const surviving = new Set(batch.tags.map((tag) => mirrorKey(userId, tag.id)));
  await Promise.all([
    ...existing.filter((key) => !surviving.has(key)).map((key) => store.delete(key)),
    ...batch.tags.map((tag) => {
      const record: MirrorTag = {
        key: mirrorKey(userId, tag.id),
        userId,
        tagId: tag.id,
        name: tag.name,
      };
      return store.put(record);
    }),
  ]);
}

/** Same full-pull reasoning as tags, plus each collection's whole membership. */
async function replaceCollections(
  transaction: MirrorTransaction,
  userId: string,
  batch: PullBatch,
): Promise<void> {
  const store = transaction.objectStore("collections");
  const edges = transaction.objectStore("collectionBooks");
  const existing = await store.index("by-user").getAllKeys(userId);
  const surviving = new Set(
    batch.collections.map((collection) => mirrorKey(userId, collection.id)),
  );
  const dropped = existing.filter((key) => !surviving.has(key));

  await Promise.all([
    ...dropped.flatMap((key) => [
      store.delete(key),
      edges.delete(mirrorPrefixRange(userId, mirrorKeyTail(key))),
    ]),
    ...batch.collections.map((collection) =>
      edges.delete(mirrorPrefixRange(userId, collection.id)),
    ),
  ]);

  await Promise.all(
    batch.collections.flatMap((collection) => {
      const record: MirrorCollection = {
        key: mirrorKey(userId, collection.id),
        userId,
        collectionId: collection.id,
        name: collection.name,
        updatedAt: collection.updatedAt,
      };
      const members: MirrorCollectionBook[] = collection.books.map((member) => ({
        key: mirrorKey(userId, collection.id, member.bookId),
        userId,
        collectionId: collection.id,
        bookId: member.bookId,
        position: member.position,
      }));
      return [store.put(record), ...members.map((member) => edges.put(member))];
    }),
  );
}

async function writePreferences(
  transaction: MirrorTransaction,
  userId: string,
  batch: PullBatch,
): Promise<void> {
  if (!batch.preferences) return;
  await transaction.objectStore("preferences").put({ userId, ...batch.preferences });
}

/** Append-only and deduped by id, so replaying a batch is a no-op. */
async function writeListeningSessions(
  transaction: MirrorTransaction,
  userId: string,
  batch: PullBatch,
): Promise<void> {
  const store = transaction.objectStore("listeningSessions");
  await Promise.all(
    batch.listeningSessions.map((session) => {
      const record: MirrorListeningSession = {
        key: mirrorKey(userId, session.id),
        userId,
        sessionId: session.id,
        bookId: session.bookId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        startPositionMs: session.startPositionMs,
        endPositionMs: session.endPositionMs,
        listenedMs: session.listenedMs,
      };
      return store.put(record);
    }),
  );
}

/**
 * `liveBookIds` is the server's complete statement of what still exists, so a
 * locally held book it omits is deleted explicitly, along with everything that
 * hangs off it. A null list — pages still outstanding — deletes nothing.
 */
async function applyTombstones(
  transaction: MirrorTransaction,
  userId: string,
  batch: PullBatch,
): Promise<void> {
  if (!batch.liveBookIds) return;
  const live = new Set(batch.liveBookIds);
  const localKeys = await transaction.objectStore("books").index("by-user").getAllKeys(userId);
  const doomed = localKeys.map(mirrorKeyTail).filter((bookId) => !live.has(bookId));
  if (!doomed.length) return;

  const doomedIds = new Set(doomed);
  const books = transaction.objectStore("books");
  const chapters = transaction.objectStore("chapters");
  const bookTags = transaction.objectStore("bookTags");
  const playbackStates = transaction.objectStore("playbackStates");
  const collectionBooks = transaction.objectStore("collectionBooks");
  const listeningSessions = transaction.objectStore("listeningSessions");

  // Collection membership is keyed `userId:collectionId:bookId`, so the doomed
  // books are found by scanning the account's edges once rather than per book.
  const [edgeKeys, sessionKeyGroups] = await Promise.all([
    collectionBooks.index("by-user").getAllKeys(userId),
    Promise.all(
      doomed.map((bookId) => listeningSessions.index("by-user-book").getAllKeys([userId, bookId])),
    ),
  ]);

  await Promise.all([
    ...doomed.flatMap((bookId) => [
      books.delete(mirrorKey(userId, bookId)),
      playbackStates.delete(mirrorKey(userId, bookId)),
      chapters.delete(mirrorPrefixRange(userId, bookId)),
      bookTags.delete(mirrorPrefixRange(userId, bookId)),
    ]),
    ...edgeKeys
      .filter((key) => doomedIds.has(mirrorKeyTail(key)))
      .map((key) => collectionBooks.delete(key)),
    ...sessionKeyGroups.flat().map((key) => listeningSessions.delete(key)),
  ]);
}

/**
 * Removes every row belonging to one account from every mirror store. Each
 * store is reached through its `by-user` index — or, where the schema gives a
 * store only a compound index, through a prefix range over that index's
 * leading `userId` component — so this is bounded and provable rather than a
 * best-effort sweep.
 */
export async function purgeUser(userId: string): Promise<void> {
  const db = await database();
  const transaction = db.transaction(MIRROR_STORES, "readwrite");

  const books = transaction.objectStore("books");
  const chapters = transaction.objectStore("chapters");
  const playbackStates = transaction.objectStore("playbackStates");
  const tags = transaction.objectStore("tags");
  const bookTags = transaction.objectStore("bookTags");
  const collections = transaction.objectStore("collections");
  const collectionBooks = transaction.objectStore("collectionBooks");
  const listeningSessions = transaction.objectStore("listeningSessions");
  const userRange = IDBKeyRange.bound([userId], [userId, "￿"]);

  const [
    bookKeys,
    chapterKeys,
    stateKeys,
    tagKeys,
    edgeKeys,
    collectionKeys,
    memberKeys,
    sessionKeys,
  ] = await Promise.all([
    books.index("by-user").getAllKeys(userId),
    chapters.index("by-user-book").getAllKeys(userRange),
    playbackStates.index("by-user").getAllKeys(userId),
    tags.index("by-user").getAllKeys(userId),
    bookTags.index("by-user").getAllKeys(userId),
    collections.index("by-user").getAllKeys(userId),
    collectionBooks.index("by-user").getAllKeys(userId),
    listeningSessions.index("by-user-book").getAllKeys(userRange),
  ]);

  await Promise.all([
    ...bookKeys.map((key) => books.delete(key)),
    ...chapterKeys.map((key) => chapters.delete(key)),
    ...stateKeys.map((key) => playbackStates.delete(key)),
    ...tagKeys.map((key) => tags.delete(key)),
    ...edgeKeys.map((key) => bookTags.delete(key)),
    ...collectionKeys.map((key) => collections.delete(key)),
    ...memberKeys.map((key) => collectionBooks.delete(key)),
    ...sessionKeys.map((key) => listeningSessions.delete(key)),
    transaction.objectStore("preferences").delete(userId),
    transaction.objectStore("syncMeta").delete(userId),
  ]);

  await transaction.done;
}

// ---------------------------------------------------------------------------
// Reads — local only, no network, no fallback
// ---------------------------------------------------------------------------

export async function getSyncMeta(userId: string): Promise<MirrorSyncMeta | undefined> {
  const db = await database();
  return db.get("syncMeta", userId);
}

type LibrarySnapshot = {
  books: MirrorBook[];
  statesByBook: Map<string, MirrorPlaybackState>;
  tagsByBook: Map<string, string[]>;
  tagNames: string[];
};

/**
 * Four indexed reads for the whole library, then everything else in memory. A
 * thousand books cost four key-range scans instead of a lookup per row, which
 * is what keeps search and filtering a per-keystroke operation.
 */
async function readLibrarySnapshot(userId: string): Promise<LibrarySnapshot> {
  const db = await database();
  const transaction = db.transaction(["books", "playbackStates", "bookTags", "tags"], "readonly");
  const [books, states, edges, tags] = await Promise.all([
    transaction.objectStore("books").index("by-user").getAll(userId),
    transaction.objectStore("playbackStates").index("by-user").getAll(userId),
    transaction.objectStore("bookTags").index("by-user").getAll(userId),
    transaction.objectStore("tags").index("by-user").getAll(userId),
    transaction.done,
  ]);

  const nameByTagId = new Map(tags.map((tag) => [tag.tagId, tag.name]));
  const tagsByBook = new Map<string, string[]>();
  for (const edge of edges) {
    const name = nameByTagId.get(edge.tagId);
    if (!name) continue;
    const names = tagsByBook.get(edge.bookId);
    if (names) names.push(name);
    else tagsByBook.set(edge.bookId, [name]);
  }
  for (const names of tagsByBook.values()) names.sort(byName);

  return {
    books,
    statesByBook: new Map(states.map((state) => [state.bookId, state])),
    tagsByBook,
    tagNames: tags.map((tag) => tag.name).sort(byName),
  };
}

function byName(left: string, right: string): number {
  return left.localeCompare(right);
}

function toLibraryBook(
  book: MirrorBook,
  state: MirrorPlaybackState | undefined,
  tags: string[],
): LibraryBook {
  return {
    id: book.bookId,
    title: book.title,
    author: book.author,
    narrator: book.narrator,
    series: book.series,
    chapterDiagnostic: book.chapterDiagnostic,
    archivedAt: book.archivedAt,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    tags,
    durationMs: book.media?.durationMs ?? null,
    positionMs: state?.positionMs ?? null,
    completed: state?.completed ?? null,
    progressUpdatedAt: state?.updatedAt ?? null,
  };
}

/** The library list: search, status facet, tag facet and sort, all on device. */
export async function listMirrorBooks(
  userId: string,
  input: MirrorLibraryQuery = {},
): Promise<LibraryBook[]> {
  const snapshot = await readLibrarySnapshot(userId);
  const status = input.status || "all";
  const needle = input.query?.trim().toLowerCase();

  const rows: LibraryBook[] = [];
  for (const book of snapshot.books) {
    const state = snapshot.statesByBook.get(book.bookId);
    if (!matchesStatus(book, state, status)) continue;
    const tags = snapshot.tagsByBook.get(book.bookId) || [];
    if (input.tag && !tags.includes(input.tag)) continue;
    if (needle && !matchesQuery(book, tags, needle)) continue;
    rows.push(toLibraryBook(book, state, tags));
  }
  return rows.sort(comparatorFor(input.sort || "activity"));
}

/** Every tag name in the account's vocabulary, for the filter chips. */
export async function listMirrorTagNames(userId: string): Promise<string[]> {
  return (await readLibrarySnapshot(userId)).tagNames;
}

/**
 * The continue card: the most recently progressed book that is neither
 * archived, finished, nor untouched — the same rule as `getLibraryOverview`.
 */
export async function getMirrorContinueBook(userId: string): Promise<LibraryBook | null> {
  const snapshot = await readLibrarySnapshot(userId);
  let best: { book: MirrorBook; state: MirrorPlaybackState } | null = null;
  for (const book of snapshot.books) {
    const state = snapshot.statesByBook.get(book.bookId);
    if (!state || !matchesStatus(book, state, "in-progress")) continue;
    if (!best || outranksForContinue(book, state, best.book, best.state)) best = { book, state };
  }
  if (!best) return null;
  return toLibraryBook(best.book, best.state, snapshot.tagsByBook.get(best.book.bookId) || []);
}

function outranksForContinue(
  book: MirrorBook,
  state: MirrorPlaybackState,
  bestBook: MirrorBook,
  bestState: MirrorPlaybackState,
): boolean {
  if (state.updatedAt !== bestState.updatedAt) return state.updatedAt > bestState.updatedAt;
  return book.bookId > bestBook.bookId;
}

function matchesStatus(
  book: MirrorBook,
  state: MirrorPlaybackState | undefined,
  status: MirrorStatus,
): boolean {
  const archived = book.archivedAt !== null;
  if (status === "archived") return archived;
  if (archived) return false;
  const completed = state?.completed || false;
  const positionMs = state?.positionMs || 0;
  if (status === "finished") return completed;
  if (status === "in-progress") return !completed && positionMs > 0;
  if (status === "not-started") return !completed && positionMs === 0;
  return true;
}

function matchesQuery(book: MirrorBook, tags: string[], needle: string): boolean {
  if (book.searchText.includes(needle)) return true;
  return tags.some((tag) => tag.toLowerCase().includes(needle));
}

function comparatorFor(sort: MirrorSort): (left: LibraryBook, right: LibraryBook) => number {
  if (sort === "title" || sort === "author") {
    return (left, right) =>
      left[sort].toLowerCase().localeCompare(right[sort].toLowerCase()) ||
      left.id.localeCompare(right.id);
  }
  if (sort === "added") {
    return (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
  }
  return (left, right) =>
    activityAt(right).localeCompare(activityAt(left)) || right.id.localeCompare(left.id);
}

/** The later of the last metadata edit and the last listen, as the server sorts. */
function activityAt(book: LibraryBook): string {
  return book.progressUpdatedAt && book.progressUpdatedAt > book.updatedAt
    ? book.progressUpdatedAt
    : book.updatedAt;
}
