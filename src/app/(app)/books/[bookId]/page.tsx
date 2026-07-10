import type { Metadata } from "next";
import { notFound } from "next/navigation";

import type { BookDetails } from "@/components/book/book-details-dialog";
import { LocalMediaGate } from "@/components/player/local-media-gate";
import type { PlayerBook } from "@/domain/player";
import { requireSession } from "@/server/auth-session";
import {
  getBookForUser,
  getNextBookInCollection,
  listBookmarksForBook,
  listRecentSessionsForBook,
} from "@/server/books/queries";

export const metadata: Metadata = { title: "Player" };

export default async function BookPage({
  params,
  searchParams,
}: {
  params: Promise<{ bookId: string }>;
  searchParams: Promise<{ autoplay?: string }>;
}) {
  const session = await requireSession();
  const { bookId } = await params;
  const { autoplay } = await searchParams;
  const [book, bookmarkRows, nextInCollection, recentSessions] = await Promise.all([
    getBookForUser(session.user.id, bookId),
    listBookmarksForBook(session.user.id, bookId),
    getNextBookInCollection(session.user.id, bookId),
    listRecentSessionsForBook(session.user.id, bookId),
  ]);
  if (!book?.durationMs) notFound();

  // The audio bytes never live on the server; the client gate resolves the
  // real media URL from this device's local store.
  const playerBook: PlayerBook = {
    id: book.id,
    title: book.title,
    author: book.author,
    durationMs: book.durationMs,
    mediaUrl: "",
    coverUrl: null,
    chapters: book.chapters.map((chapter) => ({
      id: chapter.id,
      position: chapter.position,
      title: chapter.title,
      startMs: chapter.startMs,
      endMs: chapter.endMs,
    })),
    initialPositionMs: book.positionMs || 0,
    initialPlaybackRate: Number(book.playbackRate || 1),
    completed: book.completed || false,
  };

  const details: BookDetails = {
    id: book.id,
    title: book.title,
    author: book.author,
    narrator: book.narrator,
    description: book.description,
    series: book.series,
    seriesPosition: book.seriesPosition,
    archivedAt: book.archivedAt ? book.archivedAt.toISOString() : null,
    chapterDiagnostic: book.chapterDiagnostic,
    tags: book.tags,
    recentSessions: recentSessions.map((row) => ({
      id: row.id,
      startedAt: row.startedAt.toISOString(),
      listenedMs: row.listenedMs,
    })),
  };

  const initialBookmarks = bookmarkRows.map((bookmark) => ({
    ...bookmark,
    createdAt: bookmark.createdAt.toISOString(),
  }));

  return (
    <LocalMediaGate
      userId={session.user.id}
      playerBook={playerBook}
      mediaFingerprint={book.mediaFingerprint}
      byteSize={book.byteSize}
      initialBookmarks={initialBookmarks}
      autoplay={autoplay === "1"}
      details={details}
      nextInCollection={nextInCollection}
    />
  );
}
