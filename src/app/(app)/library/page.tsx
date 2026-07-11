import type { Metadata } from "next";

import { LibraryClient } from "@/components/library/library-client";
import { requireSession } from "@/server/auth-session";
import { toLibraryBookDto } from "@/server/books/dto";
import { listBooksForUser } from "@/server/books/queries";

export const metadata: Metadata = { title: "Library" };

export default async function LibraryPage() {
  const session = await requireSession();
  const page = await listBooksForUser(session.user.id, { includeMeta: true });
  if (
    page.total === undefined ||
    page.libraryTotal === undefined ||
    page.tags === undefined ||
    page.continueBook === undefined
  ) {
    throw new Error("Library metadata was not loaded.");
  }

  return (
    <LibraryClient
      userId={session.user.id}
      initialPage={{
        ...page,
        books: page.books.map(toLibraryBookDto),
        continueBook: page.continueBook ? toLibraryBookDto(page.continueBook) : null,
      }}
    />
  );
}
