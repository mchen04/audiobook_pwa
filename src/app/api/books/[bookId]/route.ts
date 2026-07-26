import { and, count, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import { bookPatchSchema } from "@/server/api/mutation-schemas";
import {
  withMutationParams,
  withQueryParams,
  withRawMutationParams,
} from "@/server/api/route-handler";
import { getBookForUser, getOwnedBook } from "@/server/books/queries";
import { db } from "@/server/db/client";
import { books, bookTags, bookTombstones, tags } from "@/server/db/schema";
import { claimMutationReceipt } from "@/server/sync/mutation-receipt";

export const runtime = "nodejs";

const paramsSchema = z.object({ bookId: z.uuid() });
const MAX_ACCOUNT_TAGS = 100;

class TagLimitError extends Error {}

export const GET = withQueryParams(paramsSchema, async ({ session, params }) => {
  const book = await getBookForUser(session.user.id, params.bookId);
  if (!book) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ book });
});

export const PATCH = withMutationParams(
  paramsSchema,
  bookPatchSchema,
  "Invalid book update.",
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

/**
 * Applies one book↔tag edge.
 *
 * The `updatedAt` bump above is not optional bookkeeping here: `book_tags`
 * carries no timestamp of its own, so the parent's bump is the only thing that
 * puts this edge into another device's incremental pull (design contract
 * section 3). It runs before this function for every PATCH, edge or not.
 *
 * Returns false when the tag id is not this account's, which the caller turns
 * into a 404 — an edge naming somebody else's tag must not be silently ignored.
 */
async function applyTagEdge(
  transaction: Transaction,
  edge: {
    userId: string;
    bookId: string;
    tagId: string;
    include: boolean;
    mutationId?: string;
  },
): Promise<boolean> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`tags:${edge.userId}`}, 0))`,
  );

  if (edge.mutationId) {
    const receipt = await claimMutationReceipt(transaction, {
      mutationId: edge.mutationId,
      userId: edge.userId,
      bookId: edge.bookId,
    });
    // Already applied. Answering before the ownership check below is what makes
    // a replayed *removal* a no-op: the removal may have garbage-collected the
    // tag row, so re-checking ownership would 404 a write that did land.
    if (!receipt.claimed) return true;
  }

  const tagId = await resolveEdgeTag(transaction, edge);
  if (!tagId) {
    // Nothing to remove is already the desired state; only an *add* that cannot
    // name a tag is a failure the device needs to hear about.
    return !edge.include;
  }

  if (edge.include) {
    // Add-wins and idempotent: replaying "add" twice is still one edge.
    await transaction.insert(bookTags).values({ bookId: edge.bookId, tagId }).onConflictDoNothing();
  } else {
    await transaction
      .delete(bookTags)
      .where(and(eq(bookTags.bookId, edge.bookId), eq(bookTags.tagId, tagId)));
    // A tag no book references any more is not a filter chip anybody can use.
    await deleteUnusedTags(transaction, edge.userId);
  }
  return true;
}

/**
 * The tag this edge refers to, by id when the row still exists and by name
 * otherwise.
 *
 * Ids are not stable: `deleteUnusedTags` collects a tag as soon as its last
 * edge goes, so "remove fiction" followed by "add fiction back" replays a
 * second id that no longer resolves. Falling back to the queued name — and
 * re-creating the vocabulary entry for an add — is what keeps that second
 * write from being dropped as a terminal 404.
 */
async function resolveEdgeTag(
  transaction: Transaction,
  edge: { userId: string; tagId: string; include: boolean; name?: string },
): Promise<string | null> {
  const [byId] = await transaction
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.id, edge.tagId), eq(tags.userId, edge.userId)))
    .limit(1);
  if (byId) return byId.id;
  if (!edge.name) return null;

  const [byName] = await transaction
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.userId, edge.userId), eq(sql`lower(${tags.name})`, edge.name.toLowerCase())))
    .limit(1);
  if (byName) return byName.id;
  if (!edge.include) return null;

  const [created] = await transaction
    .insert(tags)
    .values({ userId: edge.userId, name: edge.name })
    .onConflictDoNothing()
    .returning({ id: tags.id });
  if (!created) return null;

  const [tagCount] = await transaction
    .select({ value: count() })
    .from(tags)
    .where(eq(tags.userId, edge.userId));
  if ((tagCount?.value || 0) > MAX_ACCOUNT_TAGS) throw new TagLimitError();
  return created.id;
}

export const DELETE = withRawMutationParams(paramsSchema, async ({ session, params }) => {
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
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`tags:${session.user.id}`}, 0))`,
    );
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
