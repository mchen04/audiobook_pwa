import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { PLAYBACK_HISTORY_LIMIT, type PlaybackAction } from "@/domain/playback-history";
import { db } from "@/server/db/client";
import { books, playbackActionReceipts, playbackActions } from "@/server/db/schema";

import { playbackHistoryLockKey } from "./lock-key";

export type PlaybackActionInput = {
  id: string;
  bookId: string;
  action: PlaybackAction;
  positionMs: number;
  previousPositionMs: number | null;
  playbackRate: number;
  description: string | null;
  occurredAt: Date;
};

export async function savePlaybackAction(userId: string, input: PlaybackActionInput) {
  return db.transaction(async (transaction) => {
    const [ownedBook] = await transaction
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.id, input.bookId), eq(books.ownerId, userId)))
      .limit(1);
    if (!ownedBook) return false;

    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${playbackHistoryLockKey(userId, input.bookId)}, 0))`,
    );
    const [inserted] = await transaction
      .insert(playbackActionReceipts)
      .values({ id: input.id, userId, bookId: input.bookId })
      .onConflictDoNothing({ target: playbackActionReceipts.id })
      .returning({ recordedAt: playbackActionReceipts.recordedAt });

    const saved =
      inserted ||
      (
        await transaction
          .select({ recordedAt: playbackActionReceipts.recordedAt })
          .from(playbackActionReceipts)
          .where(
            and(
              eq(playbackActionReceipts.id, input.id),
              eq(playbackActionReceipts.userId, userId),
              eq(playbackActionReceipts.bookId, input.bookId),
            ),
          )
          .limit(1)
      )[0];
    if (!inserted) return saved || false;

    await transaction.insert(playbackActions).values({
      ...input,
      playbackRate: String(input.playbackRate),
      recordedAt: inserted.recordedAt,
      userId,
    });

    await transaction.execute(sql`
      delete from ${playbackActions}
      where ${playbackActions.id} in (
        select ${playbackActions.id}
        from ${playbackActions}
        where ${playbackActions.userId} = ${userId}
          and ${playbackActions.bookId} = ${input.bookId}
        order by ${playbackActions.recordedAt} desc, ${playbackActions.id} desc
        offset ${PLAYBACK_HISTORY_LIMIT}
      )
    `);
    return saved;
  });
}
