import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { withMutation } from "@/server/api/route-handler";
import { getOwnedBook } from "@/server/books/queries";
import { db } from "@/server/db/client";
import { bookmarks } from "@/server/db/schema";
import { toBookmarkDto } from "@/server/books/dto";

export const runtime = "nodejs";

const bookmarkSchema = z.object({
  positionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  note: z.string().trim().max(2000).nullable().optional(),
  // Client-generated id makes offline queue replay idempotent.
  clientId: z.uuid().optional(),
});

export const POST = withMutation<typeof bookmarkSchema, { bookId: string }>(
  bookmarkSchema,
  "Invalid bookmark.",
  async ({ session, params, data }) => {
    const owned = await getOwnedBook(session.user.id, params.bookId);
    if (!owned?.durationMs) return Response.json({ error: "Not found" }, { status: 404 });

    const [created] = await db
      .insert(bookmarks)
      .values({
        userId: session.user.id,
        bookId: params.bookId,
        positionMs: Math.min(data.positionMs, owned.durationMs),
        note: data.note || null,
        clientId: data.clientId || null,
      })
      .onConflictDoNothing({ target: [bookmarks.userId, bookmarks.clientId] })
      .returning();
    if (created) return Response.json({ bookmark: toBookmarkDto(created) }, { status: 201 });

    // Only a replayed clientId can conflict; answer with the bookmark it created.
    const { clientId } = data;
    if (!clientId) return Response.json({ error: "Bookmark could not be saved." }, { status: 500 });
    const [existing] = await db
      .select()
      .from(bookmarks)
      .where(and(eq(bookmarks.userId, session.user.id), eq(bookmarks.clientId, clientId)))
      .limit(1);
    return Response.json({ bookmark: existing ? toBookmarkDto(existing) : null }, { status: 200 });
  },
);
