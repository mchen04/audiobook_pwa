import { z } from "zod";

export type LibrarySort = "activity" | "added" | "title" | "author";

export type LibraryCursor = {
  version: 1;
  sort: LibrarySort;
  value: string;
  id: string;
};

export class InvalidLibraryCursorError extends Error {}

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
