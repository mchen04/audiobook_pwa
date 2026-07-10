import { asc, eq } from "drizzle-orm";

import { withQuery } from "@/server/api/route-handler";
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
  userPreferences,
} from "@/server/db/schema";

export const runtime = "nodejs";

/**
 * Full JSON export of one account's metadata and progress. Audio bytes are the
 * user's own MP3 files and are not duplicated into the export.
 */
export const GET = withQuery(async ({ session }) => {
  const userId = session.user.id;

  const [
    bookRows,
    chapterRows,
    mediaRows,
    progressRows,
    bookmarkRows,
    tagRows,
    bookTagRows,
    collectionRows,
    collectionBookRows,
    sessionRows,
    preferenceRows,
  ] = await Promise.all([
    db.select().from(books).where(eq(books.ownerId, userId)).orderBy(asc(books.createdAt)),
    db
      .select({
        bookId: chapters.bookId,
        position: chapters.position,
        title: chapters.title,
        startMs: chapters.startMs,
        endMs: chapters.endMs,
      })
      .from(chapters)
      .innerJoin(books, eq(books.id, chapters.bookId))
      .where(eq(books.ownerId, userId))
      .orderBy(asc(chapters.bookId), asc(chapters.position)),
    db
      .select({
        bookId: mediaAssets.bookId,
        originalFilename: mediaAssets.originalFilename,
        byteSize: mediaAssets.byteSize,
        sha256: mediaAssets.sha256,
        durationMs: mediaAssets.durationMs,
      })
      .from(mediaAssets)
      .innerJoin(books, eq(books.id, mediaAssets.bookId))
      .where(eq(books.ownerId, userId)),
    db.select().from(playbackStates).where(eq(playbackStates.userId, userId)),
    db.select().from(bookmarks).where(eq(bookmarks.userId, userId)),
    db.select().from(tags).where(eq(tags.userId, userId)),
    db
      .select({ bookId: bookTags.bookId, tagId: bookTags.tagId })
      .from(bookTags)
      .innerJoin(tags, eq(tags.id, bookTags.tagId))
      .where(eq(tags.userId, userId)),
    db.select().from(collections).where(eq(collections.userId, userId)),
    db
      .select({
        collectionId: collectionBooks.collectionId,
        bookId: collectionBooks.bookId,
        position: collectionBooks.position,
      })
      .from(collectionBooks)
      .innerJoin(collections, eq(collections.id, collectionBooks.collectionId))
      .where(eq(collections.userId, userId)),
    db.select().from(listeningSessions).where(eq(listeningSessions.userId, userId)),
    db.select().from(userPreferences).where(eq(userPreferences.userId, userId)),
  ]);

  const payload = {
    format: "chapterline-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    account: { email: session.user.email, name: session.user.name },
    preferences: preferenceRows[0] || null,
    books: bookRows.map((book) => ({
      id: book.id,
      title: book.title,
      author: book.author,
      narrator: book.narrator,
      description: book.description,
      series: book.series,
      seriesPosition: book.seriesPosition,
      status: book.status,
      chapterDiagnostic: book.chapterDiagnostic,
      archivedAt: book.archivedAt,
      createdAt: book.createdAt,
      media: mediaRows.find((media) => media.bookId === book.id) || null,
      chapters: chapterRows.filter((chapter) => chapter.bookId === book.id),
    })),
    progress: progressRows,
    bookmarks: bookmarkRows,
    tags: tagRows,
    bookTags: bookTagRows,
    collections: collectionRows,
    collectionBooks: collectionBookRows,
    listeningSessions: sessionRows,
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="chapterline-export-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
});
