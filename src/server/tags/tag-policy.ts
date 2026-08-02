import "server-only";

import { and, count, eq, inArray, notInArray, sql } from "drizzle-orm";

import type { Transaction } from "@/server/db/client";
import { books, bookTags, tags } from "@/server/db/schema";
import { claimMutationReceipt } from "@/server/sync/mutation-receipt";

export const MAX_ACCOUNT_TAGS = 100;

export class TagLimitError extends Error {}

/**
 * Serializes every write that can touch this account's tag vocabulary. Taken
 * as the first statement so concurrent edge writes, full replacements, and
 * book deletions observe each other's GC and limit checks in order.
 */
export async function lockAccountTags(transaction: Transaction, userId: string): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`tags:${userId}`}, 0))`,
  );
}

/**
 * Applies one book↔tag edge.
 *
 * The caller's `updatedAt` bump is not optional bookkeeping here: `book_tags`
 * carries no timestamp of its own, so the parent's bump is the only thing that
 * puts this edge into another device's incremental pull (design contract
 * section 3). It runs before this function for every PATCH, edge or not.
 *
 * Returns false when the tag id is not this account's, which the caller turns
 * into a 404 — an edge naming somebody else's tag must not be silently ignored.
 */
export async function applyTagEdge(
  transaction: Transaction,
  edge: {
    userId: string;
    bookId: string;
    tagId: string;
    include: boolean;
    mutationId?: string;
  },
): Promise<boolean> {
  await lockAccountTags(transaction, edge.userId);

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

export async function replaceBookTags(
  transaction: Transaction,
  userId: string,
  bookId: string,
  names: string[],
): Promise<void> {
  const unique = [...new Map(names.map((name) => [name.toLowerCase(), name])).values()];

  await lockAccountTags(transaction, userId);

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

export async function deleteUnusedTags(transaction: Transaction, userId: string): Promise<void> {
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
