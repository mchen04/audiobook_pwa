import type { Metadata } from "next";

import { LibraryClient } from "@/components/library/library-client";
import { requireSession } from "@/server/auth-session";
import { toLibraryBookDto } from "@/server/books/dto";
import { encodeLibraryCursor, listBooksForUser } from "@/server/books/queries";

export const metadata: Metadata = { title: "Library" };

export default async function LibraryPage() {
  const session = await requireSession();
  const page = await listBooksForUser(session.user.id);

  return (
    <LibraryClient
      userId={session.user.id}
      initialBooks={page.books.map(toLibraryBookDto)}
      initialCursor={page.nextCursor ? encodeLibraryCursor(page.nextCursor) : null}
    />
  );
}
