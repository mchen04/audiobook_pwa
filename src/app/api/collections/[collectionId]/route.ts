import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { withMutationParams, withRawMutationParams } from "@/server/api/route-handler";
import { db } from "@/server/db/client";
import { books, collectionBooks, collections } from "@/server/db/schema";

export const runtime = "nodejs";

const paramsSchema = z.object({ collectionId: z.uuid() });

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    bookId: z.uuid(),
    include: z.boolean(),
  })
  .partial()
  .refine((value) => value.name !== undefined || value.bookId !== undefined)
  .refine((value) => (value.bookId === undefined) === (value.include === undefined));

export const PATCH = withMutationParams(
  paramsSchema,
  patchSchema,
  "Invalid collection update.",
  async ({ session, params, data }) => {
    const { name, bookId, include } = data;
    const updated = await db.transaction(async (transaction) => {
      const [owned] = await transaction
        .select({ id: collections.id })
        .from(collections)
        .where(
          and(eq(collections.id, params.collectionId), eq(collections.userId, session.user.id)),
        )
        .for("update")
        .limit(1);
      if (!owned) return "missing" as const;

      if (bookId !== undefined) {
        const [ownedBook] = await transaction
          .select({ id: books.id })
          .from(books)
          .where(and(eq(books.id, bookId), eq(books.ownerId, session.user.id)))
          .limit(1);
        if (!ownedBook) return "unavailable" as const;
      }

      if (name !== undefined) {
        await transaction
          .update(collections)
          .set({ name, updatedAt: new Date() })
          .where(eq(collections.id, params.collectionId));
      }
      if (bookId !== undefined && include === false) {
        await transaction
          .delete(collectionBooks)
          .where(
            and(
              eq(collectionBooks.collectionId, params.collectionId),
              eq(collectionBooks.bookId, bookId),
            ),
          );
      } else if (bookId !== undefined && include === true) {
        await transaction
          .insert(collectionBooks)
          .values({
            collectionId: params.collectionId,
            bookId,
            position: sql`coalesce((select max(existing.position) + 1 from ${collectionBooks} existing where existing.collection_id = ${params.collectionId}), 0)`,
          })
          .onConflictDoNothing();
      }
      return "updated" as const;
    });

    if (updated === "missing") return Response.json({ error: "Not found" }, { status: 404 });
    if (updated === "unavailable") {
      return Response.json({ error: "Collection contains an unavailable book." }, { status: 400 });
    }

    return Response.json({ updated: true });
  },
);

export const DELETE = withRawMutationParams(paramsSchema, async ({ session, params }) => {
  const deleted = await db
    .delete(collections)
    .where(and(eq(collections.id, params.collectionId), eq(collections.userId, session.user.id)))
    .returning({ id: collections.id });
  if (!deleted.length) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ deleted: true });
});
