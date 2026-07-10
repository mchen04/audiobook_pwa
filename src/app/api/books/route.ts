import { z } from "zod";

import { withQuery } from "@/server/api/route-handler";
import { toLibraryBookDto } from "@/server/books/dto";
import { encodeLibraryCursor, listBooksForUser, type LibraryCursor } from "@/server/books/queries";

export const runtime = "nodejs";

const cursorSchema = z.object({
  updatedAt: z.iso.datetime(),
  id: z.uuid(),
});

export const GET = withQuery(async ({ request, session }) => {
  const rawCursor = new URL(request.url).searchParams.get("cursor");
  let cursor: LibraryCursor | undefined;
  if (rawCursor) {
    cursor = decodeCursor(rawCursor);
    if (!cursor) return Response.json({ error: "Invalid cursor." }, { status: 400 });
  }

  const page = await listBooksForUser(session.user.id, cursor);
  return Response.json({
    books: page.books.map(toLibraryBookDto),
    nextCursor: page.nextCursor ? encodeLibraryCursor(page.nextCursor) : null,
  });
});

function decodeCursor(raw: string): LibraryCursor | undefined {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString()));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
