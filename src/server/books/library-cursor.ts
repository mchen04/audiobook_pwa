import { z } from "zod";

export type LibrarySort = "activity" | "added" | "title" | "author";

export type LibraryCursor = {
  version: 1;
  sort: LibrarySort;
  value: string;
  id: string;
};

export class InvalidLibraryCursorError extends Error {}

/** Alphabetical sorts read forward; recency sorts read newest first. */
export function librarySortsAscending(sort: LibrarySort): boolean {
  return sort === "title" || sort === "author";
}

/**
 * The keyset value for one page-boundary row. This must order exactly like the
 * SQL sort expression in `queries.ts` — and like the offline mirror's
 * comparators in `lib/offline/mirror.ts`, which `tests/parity` pins against
 * this function.
 */
export function libraryCursorValue(
  sort: LibrarySort,
  row: {
    title: string;
    author: string;
    createdAt: Date;
    updatedAt: Date;
    progressUpdatedAt: Date | null;
  },
): string {
  if (sort === "title") return row.title.toLowerCase();
  if (sort === "author") return row.author.toLowerCase();
  if (sort === "added") return row.createdAt.toISOString();
  // Activity = the later of the last metadata edit and the last listen.
  const activityAt =
    row.progressUpdatedAt && row.progressUpdatedAt > row.updatedAt
      ? row.progressUpdatedAt
      : row.updatedAt;
  return activityAt.toISOString();
}

export function encodeLibraryCursor(cursor: LibraryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeLibraryCursor(
  value: string | undefined,
  expectedSort: LibrarySort,
): LibraryCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString()) as LibraryCursor;
    const validDate =
      parsed.sort === "title" || parsed.sort === "author"
        ? true
        : z.iso.datetime().safeParse(parsed.value).success;
    if (
      parsed.version !== 1 ||
      parsed.sort !== expectedSort ||
      typeof parsed.value !== "string" ||
      !z.uuid().safeParse(parsed.id).success ||
      !validDate
    ) {
      throw new InvalidLibraryCursorError("Invalid library cursor.");
    }
    return parsed;
  } catch {
    throw new InvalidLibraryCursorError("Invalid library cursor.");
  }
}
