import type { Metadata } from "next";

import { LibraryClient } from "@/components/library/library-client";
import { requireSession } from "@/server/auth-session";
import { toLibraryBookDto } from "@/server/books/dto";
import { getLibraryOverview, listBooksPage } from "@/server/books/queries";

export const metadata: Metadata = { title: "Library" };

export default async function LibraryPage() {
  const session = await requireSession();
  const [page, overview] = await Promise.all([
    listBooksPage(session.user.id),
    getLibraryOverview(session.user.id),
  ]);

  return (
    <LibraryClient
      userId={session.user.id}
      initialPage={{
        ...page,
        ...overview,
        // The uncursored first page always carries a computed total.
        total: page.total ?? 0,
        books: page.books.map(toLibraryBookDto),
        continueBook: overview.continueBook ? toLibraryBookDto(overview.continueBook) : null,
      }}
    />
  );
}
