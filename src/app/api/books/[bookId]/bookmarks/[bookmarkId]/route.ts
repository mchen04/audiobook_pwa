import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { withMutation, withRawMutation } from "@/server/api/route-handler";
import { toBookmarkDto } from "@/server/books/dto";
import { db } from "@/server/db/client";
import { bookmarks } from "@/server/db/schema";

export const runtime = "nodejs";

type Params = { bookId: string; bookmarkId: string };

const noteSchema = z.object({
  note: z
    .string()
    .trim()
    .max(2000)
    .transform((value) => value || null)
    .nullable(),
});

export const PATCH = withMutation<typeof noteSchema, Params>(
  noteSchema,
  "Invalid note.",
  async ({ session, params, data }) => {
    const [updated] = await db
      .update(bookmarks)
      .set({ note: data.note, updatedAt: new Date() })
      .where(
        and(
          eq(bookmarks.id, params.bookmarkId),
          eq(bookmarks.bookId, params.bookId),
          eq(bookmarks.userId, session.user.id),
        ),
      )
      .returning();
    if (!updated) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ bookmark: toBookmarkDto(updated) });
  },
);

export const DELETE = withRawMutation<Params>(async ({ session, params }) => {
  const deleted = await db
    .delete(bookmarks)
    .where(
      and(
        eq(bookmarks.id, params.bookmarkId),
        eq(bookmarks.bookId, params.bookId),
        eq(bookmarks.userId, session.user.id),
      ),
    )
    .returning({ id: bookmarks.id });
  if (!deleted.length) return Response.json({ error: "Not found" }, { status: 404 });
  return new Response(null, { status: 204 });
});
