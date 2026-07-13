import type { LibraryBook } from "@/domain/library";

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

export type LibraryPage = {
  books: LibraryBook[];
  nextCursor: string | null;
  total: number;
  libraryTotal: number;
  tags: string[];
  continueBook: LibraryBook | null;
};

export function isLibraryPage(value: unknown): value is LibraryPage {
  const page = value as LibraryPage | null;
  return (
    !!page &&
    Array.isArray(page.books) &&
    page.books.every(isLibraryBook) &&
    (page.nextCursor === null || typeof page.nextCursor === "string") &&
    typeof page.total === "number" &&
    typeof page.libraryTotal === "number" &&
    Array.isArray(page.tags) &&
    (page.continueBook === null || isLibraryBook(page.continueBook))
  );
}

export type CollectionSummary = { id: string; name: string; includesBook: boolean };

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
        typeof entry.includesBook === "boolean",
    )
  );
}

export function isCollectionPayload(value: unknown): value is { collection: CollectionSummary } {
  const payload = value as { collection?: CollectionSummary } | null;
  return (
    !!payload?.collection &&
    typeof payload.collection.id === "string" &&
    typeof payload.collection.name === "string" &&
    typeof payload.collection.includesBook === "boolean"
  );
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
