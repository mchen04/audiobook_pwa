import { withQuery } from "@/server/api/route-handler";
import { toLibraryBookDto } from "@/server/books/dto";
import { InvalidLibraryCursorError } from "@/server/books/library-cursor";
import { listBooksForUser } from "@/server/books/queries";

export const runtime = "nodejs";

export const GET = withQuery(async ({ request, session }) => {
  const url = new URL(request.url);
  let library;
  try {
    library = await listBooksForUser(session.user.id, {
      query: url.searchParams.get("query") || undefined,
      status: parseEnum(url.searchParams.get("status"), [
        "all",
        "in-progress",
        "not-started",
        "finished",
        "archived",
      ]),
      tag: url.searchParams.get("tag") || undefined,
      sort: parseEnum(url.searchParams.get("sort"), ["activity", "added", "title", "author"]),
      cursor: url.searchParams.get("cursor") || undefined,
      includeMeta: url.searchParams.get("meta") !== "0",
    });
  } catch (error) {
    if (error instanceof InvalidLibraryCursorError) {
      return Response.json({ error: "Invalid library cursor." }, { status: 400 });
    }
    throw error;
  }
  return Response.json({
    ...library,
    books: library.books.map(toLibraryBookDto),
    ...("continueBook" in library
      ? { continueBook: library.continueBook ? toLibraryBookDto(library.continueBook) : null }
      : {}),
  });
});

function parseEnum<T extends string>(value: string | null, choices: readonly T[]): T | undefined {
  return choices.find((choice) => choice === value);
}
