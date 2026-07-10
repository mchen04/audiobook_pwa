import "server-only";

import type { LibraryBook } from "@/domain/library";
import type { Bookmark } from "@/domain/player";
import type { listBooksForUser } from "@/server/books/queries";
import type { bookmarks } from "@/server/db/schema";

/**
 * Wire shapes the client consumes. Serializing here keeps the domain types the
 * single source of truth instead of ad-hoc casts on both sides.
 */
export function toBookmarkDto(row: typeof bookmarks.$inferSelect): Bookmark {
  return {
    id: row.id,
    positionMs: row.positionMs,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

type LibraryRow = Awaited<ReturnType<typeof listBooksForUser>>["books"][number];

export function toLibraryBookDto(row: LibraryRow): LibraryBook {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() || null,
    progressUpdatedAt: row.progressUpdatedAt?.toISOString() || null,
  };
}
