import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import { withMutation, withQuery, withRawMutation } from "@/server/api/route-handler";
import { getBookForUser, getOwnedBook } from "@/server/books/queries";
import { db } from "@/server/db/client";
import { books, bookTags, tags } from "@/server/db/schema";

export const runtime = "nodejs";

type Params = { bookId: string };

export const GET = withQuery<Params>(async ({ session, params }) => {
  const book = await getBookForUser(session.user.id, params.bookId);
  if (!book) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ book });
});

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || null)
    .nullable();

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    author: z.string().trim().min(1).max(240),
    narrator: optionalTrimmed(240),
    description: optionalTrimmed(5000),
    series: optionalTrimmed(240),
    seriesPosition: z.number().min(0).max(999_999).nullable(),
    archived: z.boolean(),
    tags: z.array(z.string().trim().min(1).max(80)).max(20),
  })
  .partial();

export const PATCH = withMutation<typeof patchSchema, Params>(
  patchSchema,
  "Invalid book update.",
  async ({ session, params, data }) => {
    const { tags: nextTags, archived, seriesPosition, ...fields } = data;
    const owned = await getOwnedBook(session.user.id, params.bookId);
    if (!owned) return Response.json({ error: "Not found" }, { status: 404 });

    await db.transaction(async (transaction) => {
      await transaction
        .update(books)
        .set({
          ...fields,
          ...(seriesPosition !== undefined
            ? { seriesPosition: seriesPosition === null ? null : seriesPosition.toFixed(2) }
            : {}),
          ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(books.id, params.bookId));

      if (nextTags !== undefined) {
        await replaceBookTags(transaction, session.user.id, params.bookId, nextTags);
      }
    });

    const book = await getBookForUser(session.user.id, params.bookId);
    return Response.json({ book });
  },
);

export const DELETE = withRawMutation<Params>(async ({ session, params }) => {
  const owned = await getOwnedBook(session.user.id, params.bookId);
  if (!owned) return Response.json({ error: "Not found" }, { status: 404 });

  // Audio bytes live only on the user's devices; the client removes its local
  // copy alongside this row delete.
  await db.delete(books).where(eq(books.id, params.bookId));

  return Response.json({ deleted: true });
});

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function replaceBookTags(
  transaction: Transaction,
  userId: string,
  bookId: string,
  names: string[],
): Promise<void> {
  const unique = [...new Map(names.map((name) => [name.toLowerCase(), name])).values()];

  await transaction.delete(bookTags).where(eq(bookTags.bookId, bookId));
  if (unique.length) {
    const rows = await transaction
      .insert(tags)
      .values(unique.map((name) => ({ userId, name })))
      .onConflictDoNothing()
      .returning({ id: tags.id });
    const lowered = unique.map((name) => name.toLowerCase());
    const allTagRows =
      rows.length === unique.length
        ? rows
        : await transaction
            .select({ id: tags.id })
            .from(tags)
            .where(and(eq(tags.userId, userId), inArray(sql`lower(${tags.name})`, lowered)));
    await transaction
      .insert(bookTags)
      .values(allTagRows.map((tag) => ({ bookId, tagId: tag.id })))
      .onConflictDoNothing();
  }

  // Tags with no remaining books are garbage-collected so filters stay honest.
  await transaction
    .delete(tags)
    .where(
      and(
        eq(tags.userId, userId),
        notInArray(
          tags.id,
          transaction
            .select({ id: bookTags.tagId })
            .from(bookTags)
            .innerJoin(books, eq(books.id, bookTags.bookId))
            .where(eq(books.ownerId, userId)),
        ),
      ),
    );
}
