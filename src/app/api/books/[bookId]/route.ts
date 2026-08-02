import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";

import { bookPatchSchema } from "@/server/api/mutation-schemas";
import { withMutation, withQuery } from "@/server/api/route-handler";
import { getBookForUser, getOwnedBook } from "@/server/books/queries";
import { db, type Transaction } from "@/server/db/client";
import { books, bookTombstones } from "@/server/db/schema";
import {
  applyTagEdge,
  deleteUnusedTags,
  lockAccountTags,
  MAX_ACCOUNT_TAGS,
  replaceBookTags,
  TagLimitError,
} from "@/server/tags/tag-policy";

export const runtime = "nodejs";

const paramsSchema = z.object({ bookId: z.uuid() });

export const GET = withQuery({ params: paramsSchema }, async ({ session, params }) => {
  const book = await getBookForUser(session.user.id, params.bookId);
  if (!book) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ book });
});

export const PATCH = withMutation(
  { params: paramsSchema, body: bookPatchSchema, invalidBody: "Invalid book update." },
  async ({ session, params, data }) => {
    const { tags: nextTags, tagEdge, mutationId, archived, seriesPosition, ...fields } = data;
    const owned = await getOwnedBook(session.user.id, params.bookId);
    if (!owned) return Response.json({ error: "Not found" }, { status: 404 });

    let unknownTag = false;
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
        if (tagEdge !== undefined) {
          unknownTag = !(await applyTagEdge(transaction, {
            userId: session.user.id,
            bookId: params.bookId,
            mutationId,
            ...tagEdge,
          }));
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

    if (unknownTag) return Response.json({ error: "Unknown tag." }, { status: 404 });

    const book = await getBookForUser(session.user.id, params.bookId);
    return Response.json({ book });
  },
);

export const DELETE = withMutation({ params: paramsSchema }, async ({ session, params }) => {
  const owned = await getOwnedBook(session.user.id, params.bookId);
  if (!owned) {
    // Idempotent replay: a queued delete that already landed must not come back
    // as 404, or the outbox would treat a successful write as a terminal
    // failure. The tombstone is the durable proof it landed.
    const [tombstone] = await db
      .select({ bookId: bookTombstones.bookId })
      .from(bookTombstones)
      .where(
        and(eq(bookTombstones.bookId, params.bookId), eq(bookTombstones.ownerId, session.user.id)),
      )
      .limit(1);
    if (!tombstone) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ deleted: true, alreadyDeleted: true });
  }

  // Audio bytes live only on the user's devices; the client removes its local
  // copy alongside this row delete. Tags unique to this book are collected in
  // the same transaction so no orphaned filter chips linger.
  await db.transaction(async (transaction) => {
    await lockAccountTags(transaction, session.user.id);
    await transaction.delete(books).where(eq(books.id, params.bookId));
    // Same transaction as the delete: a deletion the user saw succeed can never
    // exist without the tombstone that tells the user's other devices about it.
    await transaction
      .insert(bookTombstones)
      .values({ bookId: params.bookId, ownerId: session.user.id })
      .onConflictDoUpdate({
        target: bookTombstones.bookId,
        set: { deletedAt: new Date() },
      });
    await deleteUnusedTags(transaction, session.user.id);
    await pruneExpiredTombstones(transaction, session.user.id);
  });

  return Response.json({ deleted: true });
});

/**
 * A device offline for longer than this has a stale cursor anyway and re-syncs
 * from a full pull, which conveys deletions by absence from the complete book
 * list. Matches the receipt retention horizon in `server/playback/history.ts`.
 */
const TOMBSTONE_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

async function pruneExpiredTombstones(transaction: Transaction, userId: string): Promise<void> {
  await transaction
    .delete(bookTombstones)
    .where(
      and(
        eq(bookTombstones.ownerId, userId),
        lt(bookTombstones.deletedAt, new Date(Date.now() - TOMBSTONE_RETENTION_MS)),
      ),
    );
}
