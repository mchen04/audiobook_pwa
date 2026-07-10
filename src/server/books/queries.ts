import { and, asc, desc, eq, sql } from "drizzle-orm";

import { db } from "@/server/db/client";
import {
  bookmarks,
  books,
  bookTags,
  chapters,
  collectionBooks,
  collections,
  listeningSessions,
  mediaAssets,
  playbackStates,
  tags,
} from "@/server/db/schema";

export type LibraryCursor = {
  updatedAt: string;
  id: string;
};

export function encodeLibraryCursor(cursor: LibraryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

const LIBRARY_PAGE_SIZE = 50;

/**
 * One deterministic keyset page of the library ordered by recency. Large
 * libraries stream page by page; fetching everything at once measurably blows
 * the latency budget against a remote database.
 */
export async function listBooksForUser(userId: string, cursor?: LibraryCursor) {
  const rows = await db
    .select({
      id: books.id,
      title: books.title,
      author: books.author,
      narrator: books.narrator,
      series: books.series,
      chapterDiagnostic: books.chapterDiagnostic,
      archivedAt: books.archivedAt,
      createdAt: books.createdAt,
      updatedAt: books.updatedAt,
      durationMs: mediaAssets.durationMs,
      positionMs: playbackStates.positionMs,
      completed: playbackStates.completed,
      progressUpdatedAt: playbackStates.updatedAt,
      // One round trip: tags ride along as a JSON aggregate per book.
      tags: sql<string[]>`coalesce((
        select json_agg(${tags.name} order by ${tags.name})
        from ${bookTags}
        join ${tags} on ${tags.id} = ${bookTags.tagId}
        where ${bookTags.bookId} = ${books.id}
      ), '[]'::json)`,
    })
    .from(books)
    .leftJoin(mediaAssets, eq(mediaAssets.bookId, books.id))
    .leftJoin(
      playbackStates,
      and(eq(playbackStates.bookId, books.id), eq(playbackStates.userId, userId)),
    )
    .where(
      and(
        eq(books.ownerId, userId),
        cursor
          ? sql`(${books.updatedAt}, ${books.id}) < (${cursor.updatedAt}::timestamptz, ${cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(books.updatedAt), desc(books.id))
    .limit(LIBRARY_PAGE_SIZE + 1);

  const page = rows.slice(0, LIBRARY_PAGE_SIZE);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > LIBRARY_PAGE_SIZE && last
      ? { updatedAt: last.updatedAt.toISOString(), id: last.id }
      : null;

  return { books: page, nextCursor };
}

export async function getBookForUser(userId: string, bookId: string) {
  const [book] = await db
    .select({
      id: books.id,
      title: books.title,
      author: books.author,
      narrator: books.narrator,
      description: books.description,
      series: books.series,
      seriesPosition: books.seriesPosition,
      archivedAt: books.archivedAt,
      chapterDiagnostic: books.chapterDiagnostic,
      byteSize: mediaAssets.byteSize,
      durationMs: mediaAssets.durationMs,
      mimeType: mediaAssets.mimeType,
      mediaFingerprint: mediaAssets.sha256,
      positionMs: playbackStates.positionMs,
      playbackRate: playbackStates.playbackRate,
      completed: playbackStates.completed,
      progressUpdatedAt: playbackStates.updatedAt,
    })
    .from(books)
    .leftJoin(mediaAssets, eq(mediaAssets.bookId, books.id))
    .leftJoin(
      playbackStates,
      and(eq(playbackStates.bookId, books.id), eq(playbackStates.userId, userId)),
    )
    .where(and(eq(books.id, bookId), eq(books.ownerId, userId)))
    .limit(1);

  if (!book) return null;
  const [chapterRows, tagRows] = await Promise.all([
    db.select().from(chapters).where(eq(chapters.bookId, bookId)).orderBy(chapters.position),
    db
      .select({ name: tags.name })
      .from(bookTags)
      .innerJoin(tags, eq(tags.id, bookTags.tagId))
      .where(eq(bookTags.bookId, bookId))
      .orderBy(asc(tags.name)),
  ]);

  return { ...book, chapters: chapterRows, tags: tagRows.map((tag) => tag.name) };
}

/**
 * The next unfinished book after this one inside the first ordered collection
 * that contains it, used for optional continuous series play.
 */
export async function getNextBookInCollection(userId: string, bookId: string) {
  const [membership] = await db
    .select({ collectionId: collectionBooks.collectionId, position: collectionBooks.position })
    .from(collectionBooks)
    .innerJoin(collections, eq(collections.id, collectionBooks.collectionId))
    .where(and(eq(collectionBooks.bookId, bookId), eq(collections.userId, userId)))
    .orderBy(asc(collectionBooks.position))
    .limit(1);
  if (!membership) return null;

  const [next] = await db
    .select({ id: books.id, title: books.title, collectionName: collections.name })
    .from(collectionBooks)
    .innerJoin(books, eq(books.id, collectionBooks.bookId))
    .innerJoin(collections, eq(collections.id, collectionBooks.collectionId))
    .where(
      and(
        eq(collectionBooks.collectionId, membership.collectionId),
        sql`${collectionBooks.position} > ${membership.position}`,
        eq(books.ownerId, userId),
        eq(books.status, "ready"),
      ),
    )
    .orderBy(asc(collectionBooks.position))
    .limit(1);
  return next || null;
}

export async function listRecentSessionsForBook(userId: string, bookId: string, limit = 5) {
  return db
    .select({
      id: listeningSessions.id,
      startedAt: listeningSessions.startedAt,
      endedAt: listeningSessions.endedAt,
      startPositionMs: listeningSessions.startPositionMs,
      endPositionMs: listeningSessions.endPositionMs,
      listenedMs: listeningSessions.listenedMs,
    })
    .from(listeningSessions)
    .where(and(eq(listeningSessions.userId, userId), eq(listeningSessions.bookId, bookId)))
    .orderBy(desc(listeningSessions.startedAt))
    .limit(limit);
}

/** The single row an INSERT/UPDATE ... RETURNING must produce. */
export function expectRow<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error("Expected a returned row.");
  return row;
}

/** Canonical ownership lookup for book mutations. Null when not owned. */
export async function getOwnedBook(userId: string, bookId: string) {
  const [owned] = await db
    .select({
      id: books.id,
      durationMs: mediaAssets.durationMs,
    })
    .from(books)
    .leftJoin(mediaAssets, eq(mediaAssets.bookId, books.id))
    .where(and(eq(books.id, bookId), eq(books.ownerId, userId)))
    .limit(1);
  return owned || null;
}

export async function listBookmarksForBook(userId: string, bookId: string) {
  return db
    .select({
      id: bookmarks.id,
      positionMs: bookmarks.positionMs,
      note: bookmarks.note,
      createdAt: bookmarks.createdAt,
    })
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, userId), eq(bookmarks.bookId, bookId)))
    .orderBy(bookmarks.positionMs);
}
