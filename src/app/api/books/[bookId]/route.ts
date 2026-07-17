import { and, count, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import {
  withMutationParams,
  withQueryParams,
  withRawMutationParams,
} from "@/server/api/route-handler";
import { getBookForUser, getOwnedBook } from "@/server/books/queries";
import { db } from "@/server/db/client";
import { books, bookTags, tags } from "@/server/db/schema";

export const runtime = "nodejs";

const paramsSchema = z.object({ bookId: z.uuid() });
const MAX_ACCOUNT_TAGS = 100;

class TagLimitError extends Error {}

export const GET = withQueryParams(paramsSchema, async ({ session, params }) => {
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

export const PATCH = withMutationParams(
  paramsSchema,
  patchSchema,
  "Invalid book update.",
  async ({ session, params, data }) => {
    const { tags: nextTags, archived, seriesPosition, ...fields } = data;
    const owned = await getOwnedBook(session.user.id, params.bookId);
    if (!owned) return Response.json({ error: "Not found" }, { status: 404 });

    try {
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
    } catch (error) {
      if (error instanceof TagLimitError) {
        return Response.json(
          { error: `An account can have up to ${MAX_ACCOUNT_TAGS} tags.` },
          { status: 409 },
        );
      }
      throw error;
    }

    const book = await getBookForUser(session.user.id, params.bookId);
    return Response.json({ book });
  },
);

export const DELETE = withRawMutationParams(paramsSchema, async ({ session, params }) => {
  const owned = await getOwnedBook(session.user.id, params.bookId);
  if (!owned) return Response.json({ error: "Not found" }, { status: 404 });

  // Audio bytes live only on the user's devices; the client removes its local
  // copy alongside this row delete. Tags unique to this book are collected in
  // the same transaction so no orphaned filter chips linger.
  await db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`tags:${session.user.id}`}, 0))`,
    );
    await transaction.delete(books).where(eq(books.id, params.bookId));
    await deleteUnusedTags(transaction, session.user.id);
  });

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

  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`tags:${userId}`}, 0))`,
  );

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

  // A single GC pass after the re-insert keeps ids stable for tags this book
  // still uses and collects the ones nothing references; checking the limit
  // against the final state stays exact because the transaction rolls back.
  await deleteUnusedTags(transaction, userId);
  const [tagCount] = await transaction
    .select({ value: count() })
    .from(tags)
    .where(eq(tags.userId, userId));
  if ((tagCount?.value || 0) > MAX_ACCOUNT_TAGS) throw new TagLimitError();
}

async function deleteUnusedTags(transaction: Transaction, userId: string): Promise<void> {
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
