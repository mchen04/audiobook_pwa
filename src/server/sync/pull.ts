import "server-only";

import { and, asc, desc, eq, getTableColumns, inArray, sql, type SQLWrapper } from "drizzle-orm";

import type {
  PullBatch,
  PulledBook,
  PulledCollection,
  PulledListeningSession,
  PulledPlaybackState,
  PulledTag,
  PulledTombstone,
} from "@/lib/offline/sync-protocol";
import { db, type Transaction } from "@/server/db/client";
import { serializePlayerPreferences } from "@/server/preferences/write-policy";
import { planBookPage } from "@/server/sync/page-plan";
import { planTombstoneWindow } from "@/server/sync/tombstone-window";
import {
  books,
  bookTags,
  bookTombstones,
  chapters,
  collectionBooks,
  collections,
  listeningSessions,
  mediaAssets,
  playbackStates,
  tags,
  userPreferences,
} from "@/server/db/schema";

/**
 * The read side of sync. It reads exactly the table set that
 * `account/export-stream.ts` reads, under the same read-only repeatable-read
 * transaction, so every stream in one batch sees one consistent snapshot.
 *
 * Nothing here can return audio bytes or transcript cues: `media_assets` holds
 * no storage key or URL column, and transcripts are not a server table at all.
 */

const BOOK_PAGE_SIZE = 200;
const RECENT_SESSION_LIMIT = 200;
const EPOCH_CURSOR = "1970-01-01T00:00:00.000000Z";

/**
 * Cursors are microsecond-precision UTC text, produced by and compared against
 * Postgres directly.
 *
 * A `Date` would silently truncate `timestamptz` to milliseconds, and a cursor
 * that rounds down below the row it describes re-selects that row forever —
 * a pull loop that never terminates. Fixed-width UTC text also compares
 * lexicographically in JavaScript exactly as it orders in the database.
 */
function isoMicros(column: SQLWrapper) {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

function after(column: SQLWrapper, cursor: string) {
  return sql`${column} > ${cursor}::timestamptz`;
}

export async function loadPullBatch(
  userId: string,
  since: string | null,
  options: { finalSnapshotsOnly?: boolean } = {},
): Promise<PullBatch> {
  return db.transaction(
    async (transaction) => {
      const floor = since || EPOCH_CURSOR;
      const page = await loadBookPage(transaction, userId, floor);
      const states = await loadPlaybackStates(transaction, userId, floor, page);
      const window = planTombstoneWindow(since, page);
      const tombstones = await loadTombstones(transaction, userId, window);
      const cursor = page.complete
        ? latest(
            floor,
            page.rows.at(-1)?.cursorAt,
            states.at(-1)?.cursorAt,
            // Only a window that was not clamped may move the cursor; a clamped
            // one has already been bounded by the page watermark below.
            window.emit && window.advancesCursor ? tombstones.at(-1)?.deletedAt : undefined,
          )
        : page.watermark;

      // The snapshot streams — tags, collections, preferences, sessions — are
      // whole-account truths, so re-sending them on every page of a paged sync
      // is pure waste: only the final page's copy survives. But a bundle that
      // predates the mirror's `complete` gate applies every page's streams
      // unconditionally, and an interim page's empty copies would wipe its
      // local state. Only a client that declared `snapshots=final` may be
      // spared the interim copies.
      const snapshotPage = page.complete || !options.finalSnapshotsOnly;
      const [aggregates, tagRows, collectionRows, preferences, sessions, liveBookIds] =
        await Promise.all([
          loadBookAggregates(transaction, page.rows),
          snapshotPage ? loadTags(transaction, userId) : Promise.resolve([]),
          snapshotPage ? loadCollections(transaction, userId) : Promise.resolve([]),
          snapshotPage ? loadPreferences(transaction, userId) : Promise.resolve(null),
          snapshotPage ? loadRecentSessions(transaction, userId) : Promise.resolve([]),
          // Incremental pulls learn deletions from `tombstones`, but the
          // complete id list still rides every final page: clients installed
          // before tombstone consumption shipped ignore `tombstones` entirely,
          // and a cursor older than the tombstone retention window (route
          // DELETE prunes at 365 days) would silently miss deletions. It may
          // drop to first-sync-only once neither reader exists.
          page.complete ? loadLiveBookIds(transaction, userId) : Promise.resolve(null),
        ]);

      return {
        since,
        cursor,
        complete: page.complete,
        books: aggregates,
        playbackStates: states.map(toPulledPlaybackState),
        tags: tagRows,
        collections: collectionRows,
        preferences,
        listeningSessions: sessions,
        liveBookIds,
        tombstones,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

type BookRow = typeof books.$inferSelect & { cursorAt: string };
type BookPage = { rows: BookRow[]; watermark: string; complete: boolean };

/**
 * One page of changed books, ordered by the cursor index
 * `books (owner_id, updated_at, id)`.
 *
 * The page never splits a timestamp. A bulk import writes every one of its
 * books with the transaction's single `now()`, so a page boundary landing
 * inside such a group would strand the rest of it behind a cursor that has
 * already moved past them. When that group is itself larger than a page, the
 * whole group is fetched instead — bounded by the size of one import.
 */
async function loadBookPage(
  transaction: Transaction,
  userId: string,
  floor: string,
): Promise<BookPage> {
  const selection = { ...getTableColumns(books), cursorAt: isoMicros(books.updatedAt) };
  const rows = await transaction
    .select(selection)
    .from(books)
    .where(and(eq(books.ownerId, userId), after(books.updatedAt, floor)))
    .orderBy(asc(books.updatedAt), asc(books.id))
    .limit(BOOK_PAGE_SIZE + 1);

  const plan = planBookPage(
    rows.map((row) => row.cursorAt),
    floor,
    BOOK_PAGE_SIZE,
  );
  if (plan.kind !== "bucket") {
    return {
      rows: rows.slice(0, plan.take),
      watermark: plan.watermark,
      complete: plan.kind === "final",
    };
  }

  const [bucket, [beyond]] = await Promise.all([
    transaction
      .select(selection)
      .from(books)
      .where(
        and(eq(books.ownerId, userId), sql`${books.updatedAt} = ${plan.boundary}::timestamptz`),
      )
      .orderBy(asc(books.id)),
    transaction
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.ownerId, userId), after(books.updatedAt, plan.boundary)))
      .limit(1),
  ]);
  return { rows: bucket, watermark: plan.boundary, complete: !beyond };
}

/**
 * Progress moves without touching `books.updatedAt`, so it is its own stream.
 * While book pages remain it is clamped to the page watermark, which keeps a
 * single scalar cursor sound for both streams.
 */
async function loadPlaybackStates(
  transaction: Transaction,
  userId: string,
  floor: string,
  page: BookPage,
) {
  return transaction
    .select({ ...getTableColumns(playbackStates), cursorAt: isoMicros(playbackStates.updatedAt) })
    .from(playbackStates)
    .where(
      and(
        eq(playbackStates.userId, userId),
        after(playbackStates.updatedAt, floor),
        ...(page.complete
          ? []
          : [sql`${playbackStates.updatedAt} <= ${page.watermark}::timestamptz`]),
      ),
    )
    .orderBy(asc(playbackStates.updatedAt), asc(playbackStates.bookId));
}

function toPulledPlaybackState(row: typeof playbackStates.$inferSelect): PulledPlaybackState {
  return {
    bookId: row.bookId,
    positionMs: row.positionMs,
    playbackRate: Number(row.playbackRate),
    completed: row.completed,
    deviceId: row.deviceId,
    deviceSequence: row.deviceSequence,
    eventOccurredAt: row.eventOccurredAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Chapters and tag edges travel with their book; neither carries an `updatedAt`. */
async function loadBookAggregates(
  transaction: Transaction,
  rows: BookRow[],
): Promise<PulledBook[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const [mediaRows, chapterRows, edgeRows] = await Promise.all([
    transaction
      .select({
        bookId: mediaAssets.bookId,
        originalFilename: mediaAssets.originalFilename,
        mimeType: mediaAssets.mimeType,
        byteSize: mediaAssets.byteSize,
        fingerprint: mediaAssets.fingerprint,
        fingerprintKind: mediaAssets.fingerprintKind,
        durationMs: mediaAssets.durationMs,
      })
      .from(mediaAssets)
      .where(inArray(mediaAssets.bookId, ids)),
    transaction
      .select({
        bookId: chapters.bookId,
        position: chapters.position,
        title: chapters.title,
        startMs: chapters.startMs,
        endMs: chapters.endMs,
      })
      .from(chapters)
      .where(inArray(chapters.bookId, ids))
      .orderBy(asc(chapters.bookId), asc(chapters.position)),
    transaction
      .select({ bookId: bookTags.bookId, tagId: bookTags.tagId })
      .from(bookTags)
      .where(inArray(bookTags.bookId, ids))
      .orderBy(asc(bookTags.bookId), asc(bookTags.tagId)),
  ]);

  const mediaByBook = new Map(mediaRows.map((media) => [media.bookId, media]));
  const chaptersByBook = groupBy(chapterRows, (row) => row.bookId);
  const edgesByBook = groupBy(edgeRows, (row) => row.bookId);

  return rows.map((row) => {
    const media = mediaByBook.get(row.id);
    return {
      id: row.id,
      title: row.title,
      author: row.author,
      narrator: row.narrator,
      description: row.description,
      series: row.series,
      seriesPosition: row.seriesPosition,
      chapterDiagnostic: row.chapterDiagnostic,
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      media: media
        ? {
            originalFilename: media.originalFilename,
            mimeType: media.mimeType,
            byteSize: media.byteSize,
            fingerprint: media.fingerprint,
            fingerprintKind: media.fingerprintKind,
            durationMs: media.durationMs,
          }
        : null,
      chapters: (chaptersByBook.get(row.id) || []).map((chapter) => ({
        position: chapter.position,
        title: chapter.title,
        startMs: chapter.startMs,
        endMs: chapter.endMs,
      })),
      tagIds: (edgesByBook.get(row.id) || []).map((edge) => edge.tagId),
    };
  });
}

async function loadTags(transaction: Transaction, userId: string): Promise<PulledTag[]> {
  return transaction
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(eq(tags.userId, userId))
    .orderBy(asc(tags.name));
}

async function loadCollections(
  transaction: Transaction,
  userId: string,
): Promise<PulledCollection[]> {
  const rows = await transaction
    .select({ id: collections.id, name: collections.name, updatedAt: collections.updatedAt })
    .from(collections)
    .where(eq(collections.userId, userId))
    .orderBy(asc(collections.id));
  if (!rows.length) return [];

  const memberRows = await transaction
    .select({
      collectionId: collectionBooks.collectionId,
      bookId: collectionBooks.bookId,
      position: collectionBooks.position,
    })
    .from(collectionBooks)
    .where(
      inArray(
        collectionBooks.collectionId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(collectionBooks.collectionId), asc(collectionBooks.position));
  const membersByCollection = groupBy(memberRows, (row) => row.collectionId);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    updatedAt: row.updatedAt.toISOString(),
    books: (membersByCollection.get(row.id) || []).map((member) => ({
      bookId: member.bookId,
      position: member.position,
    })),
  }));
}

async function loadPreferences(transaction: Transaction, userId: string) {
  const [row] = await transaction
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  if (!row) return null;
  return {
    ...serializePlayerPreferences(row),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Append-only and deduped by id on the device, so a full recent window is safe. */
async function loadRecentSessions(
  transaction: Transaction,
  userId: string,
): Promise<PulledListeningSession[]> {
  const rows = await transaction
    .select({
      id: listeningSessions.id,
      bookId: listeningSessions.bookId,
      startedAt: listeningSessions.startedAt,
      endedAt: listeningSessions.endedAt,
      startPositionMs: listeningSessions.startPositionMs,
      endPositionMs: listeningSessions.endPositionMs,
      listenedMs: listeningSessions.listenedMs,
    })
    .from(listeningSessions)
    .where(eq(listeningSessions.userId, userId))
    .orderBy(desc(listeningSessions.startedAt))
    .limit(RECENT_SESSION_LIMIT);
  return rows.map((row) => ({
    id: row.id,
    bookId: row.bookId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    startPositionMs: row.startPositionMs,
    endPositionMs: row.endPositionMs,
    listenedMs: row.listenedMs,
  }));
}

/**
 * Per-row deletions, from the tombstone written in the same transaction as the
 * delete. Ordered by `deleted_at` so the last row is the window's high-water
 * mark, and index-only over `book_tombstones (owner_id, deleted_at, book_id)`.
 *
 * This is the deletion signal that scales: its cost tracks the number of
 * deletions since the device's cursor, not the size of the library.
 */
async function loadTombstones(
  transaction: Transaction,
  userId: string,
  window: ReturnType<typeof planTombstoneWindow>,
): Promise<PulledTombstone[]> {
  if (!window.emit) return [];
  const rows = await transaction
    .select({
      bookId: bookTombstones.bookId,
      deletedAt: isoMicros(bookTombstones.deletedAt),
    })
    .from(bookTombstones)
    .where(
      and(
        eq(bookTombstones.ownerId, userId),
        after(bookTombstones.deletedAt, window.floor),
        ...(window.ceiling
          ? [sql`${bookTombstones.deletedAt} <= ${window.ceiling}::timestamptz`]
          : []),
      ),
    )
    .orderBy(asc(bookTombstones.deletedAt), asc(bookTombstones.bookId));
  return rows;
}

/**
 * The complete deletion oracle. This unpaged id list is the explicit statement
 * of what still exists, and the device turns the difference into deletes. It
 * anchors a first sync (which has no cursor for tombstones), heals a cursor
 * older than tombstone retention, and keeps pre-tombstone clients correct.
 * Index-only over `books (owner_id, updated_at, id)`.
 */
async function loadLiveBookIds(transaction: Transaction, userId: string): Promise<string[]> {
  const rows = await transaction
    .select({ id: books.id })
    .from(books)
    .where(eq(books.ownerId, userId))
    .orderBy(asc(books.id));
  return rows.map((row) => row.id);
}

function groupBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(keyOf(row));
    if (bucket) bucket.push(row);
    else grouped.set(keyOf(row), [row]);
  }
  return grouped;
}

function latest(floor: string, ...candidates: (string | undefined)[]): string {
  return candidates.reduce<string>(
    (best, candidate) => (candidate && candidate > best ? candidate : best),
    floor,
  );
}
