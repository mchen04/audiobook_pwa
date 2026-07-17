import { withQuery } from "@/server/api/route-handler";
import { toLibraryBookDto } from "@/server/books/dto";
import { InvalidLibraryCursorError } from "@/server/books/library-cursor";
import { getLibraryOverview, listBooksPage } from "@/server/books/queries";

export const runtime = "nodejs";

export const GET = withQuery(async ({ request, session }) => {
  const url = new URL(request.url);
  // meta=0 skips the filter-independent overview (pagination, filter changes).
  const withOverview = url.searchParams.get("meta") !== "0";
  let page, overview;
  try {
    [page, overview] = await Promise.all([
      listBooksPage(session.user.id, {
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
      }),
      withOverview ? getLibraryOverview(session.user.id) : null,
    ]);
  } catch (error) {
    if (error instanceof InvalidLibraryCursorError) {
      return Response.json({ error: "Invalid library cursor." }, { status: 400 });
    }
    throw error;
  }
  return Response.json({
    ...page,
    books: page.books.map(toLibraryBookDto),
    ...(overview
      ? {
          ...overview,
          continueBook: overview.continueBook ? toLibraryBookDto(overview.continueBook) : null,
        }
      : {}),
  });
});

function parseEnum<T extends string>(value: string | null, choices: readonly T[]): T | undefined {
  return choices.find((choice) => choice === value);
}
