import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { withMutation, withRawMutation } from "@/server/api/route-handler";
import { db } from "@/server/db/client";
import { books, collectionBooks, collections } from "@/server/db/schema";

export const runtime = "nodejs";

type Params = { collectionId: string };

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    bookIds: z.array(z.uuid()).max(500),
  })
  .partial();

export const PATCH = withMutation<typeof patchSchema, Params>(
  patchSchema,
  "Invalid collection update.",
  async ({ session, params, data }) => {
    const [owned] = await db
      .select({ id: collections.id })
      .from(collections)
      .where(and(eq(collections.id, params.collectionId), eq(collections.userId, session.user.id)))
      .limit(1);
    if (!owned) return Response.json({ error: "Not found" }, { status: 404 });

    const { name, bookIds } = data;
    await db.transaction(async (transaction) => {
      if (name !== undefined) {
        await transaction
          .update(collections)
          .set({ name, updatedAt: new Date() })
          .where(eq(collections.id, params.collectionId));
      }
      if (bookIds !== undefined) {
        // Membership only ever references the caller's own books.
        const ownedBooks = bookIds.length
          ? await transaction
              .select({ id: books.id })
              .from(books)
              .where(and(inArray(books.id, bookIds), eq(books.ownerId, session.user.id)))
          : [];
        const allowed = new Set(ownedBooks.map((book) => book.id));
        const ordered = bookIds.filter((bookId) => allowed.has(bookId));

        await transaction
          .delete(collectionBooks)
          .where(eq(collectionBooks.collectionId, params.collectionId));
        if (ordered.length) {
          await transaction.insert(collectionBooks).values(
            ordered.map((bookId, position) => ({
              collectionId: params.collectionId,
              bookId,
              position,
            })),
          );
        }
      }
    });

    return Response.json({ updated: true });
  },
);

export const DELETE = withRawMutation<Params>(async ({ session, params }) => {
  const deleted = await db
    .delete(collections)
    .where(and(eq(collections.id, params.collectionId), eq(collections.userId, session.user.id)))
    .returning({ id: collections.id });
  if (!deleted.length) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ deleted: true });
});
