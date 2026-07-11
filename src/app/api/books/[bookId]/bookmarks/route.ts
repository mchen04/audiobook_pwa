import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { withMutationParams, withRawMutationParams } from "@/server/api/route-handler";
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
const paramsSchema = z.object({ bookId: z.uuid() });

export const POST = withMutationParams(
  paramsSchema,
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
      .onConflictDoUpdate({
        target: [bookmarks.userId, bookmarks.clientId],
        set: { note: data.note || null, updatedAt: new Date() },
        setWhere: eq(bookmarks.bookId, params.bookId),
      })
      .returning();
    if (!created) {
      return Response.json(
        { error: "Bookmark identity belongs to another book." },
        { status: 409 },
      );
    }
    return Response.json({ bookmark: toBookmarkDto(created) }, { status: 201 });
  },
);

export const DELETE = withRawMutationParams(paramsSchema, async ({ request, session, params }) => {
  const clientId = new URL(request.url).searchParams.get("clientId");
  if (!z.uuid().safeParse(clientId).success) {
    return Response.json({ error: "Invalid bookmark identity." }, { status: 400 });
  }
  const [deleted] = await db
    .delete(bookmarks)
    .where(
      and(
        eq(bookmarks.userId, session.user.id),
        eq(bookmarks.bookId, params.bookId),
        eq(bookmarks.clientId, clientId!),
      ),
    )
    .returning({ id: bookmarks.id });
  return Response.json({ bookmarkId: deleted?.id ?? null });
});
