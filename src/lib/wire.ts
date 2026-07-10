import type { LibraryBook } from "@/domain/library";
import type { Bookmark } from "@/domain/player";

/**
 * Runtime guards for API responses, so a server shape change fails loudly at
 * the fetch boundary instead of silently at a distant use site.
 */
export async function readJson<T>(
  response: Response,
  guard: (value: unknown) => value is T,
): Promise<T | null> {
  if (!response.ok) return null;
  const data: unknown = await response.json().catch(() => null);
  return guard(data) ? data : null;
}

export type LibraryPage = { books: LibraryBook[]; nextCursor: string | null };

export function isLibraryPage(value: unknown): value is LibraryPage {
  const page = value as LibraryPage | null;
  return (
    !!page &&
    Array.isArray(page.books) &&
    page.books.every(isLibraryBook) &&
    (page.nextCursor === null || typeof page.nextCursor === "string")
  );
}

export type BookmarkPayload = { bookmark: Bookmark };

export function isBookmarkPayload(value: unknown): value is BookmarkPayload {
  const payload = value as BookmarkPayload | null;
  if (!payload || typeof payload.bookmark !== "object" || payload.bookmark === null) return false;
  const bookmark = payload.bookmark;
  return (
    typeof bookmark.id === "string" &&
    typeof bookmark.positionMs === "number" &&
    (bookmark.note === null || typeof bookmark.note === "string") &&
    typeof bookmark.createdAt === "string"
  );
}

export type CollectionSummary = { id: string; name: string; bookIds: string[] };

export function isCollectionList(value: unknown): value is { collections: CollectionSummary[] } {
  const payload = value as { collections?: unknown } | null;
  return (
    !!payload &&
    Array.isArray(payload.collections) &&
    payload.collections.every(
      (entry: CollectionSummary) =>
        entry &&
        typeof entry.id === "string" &&
        typeof entry.name === "string" &&
        Array.isArray(entry.bookIds),
    )
  );
}

export function isCollectionPayload(value: unknown): value is { collection: CollectionSummary } {
  const payload = value as { collection?: CollectionSummary } | null;
  return !!payload?.collection && typeof payload.collection.id === "string";
}

function isLibraryBook(value: unknown): value is LibraryBook {
  const book = value as LibraryBook | null;
  return (
    !!book &&
    typeof book.id === "string" &&
    typeof book.title === "string" &&
    typeof book.author === "string" &&
    Array.isArray(book.tags)
  );
}
