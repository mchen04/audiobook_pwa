import { and, eq, lt, sql } from "drizzle-orm";

import { db } from "@/server/db/client";
import { books, mediaAssets, playbackDeviceSequences, playbackStates } from "@/server/db/schema";

import { decideProgressUpdate } from "./progress-policy";

export type ProgressInput = {
  bookId: string;
  deviceId: string;
  deviceSequence: number;
  positionMs: number;
  playbackRate: number;
  completed: boolean;
  eventOccurredAt: Date;
};

type PlaybackStateRow = typeof playbackStates.$inferSelect;

/**
 * The hottest write path (15s heartbeats plus every transport action), kept
 * to three statements inside the lock: ownership+existing in one read, then
 * the sequence claim and state upsert folded into one insert.
 */
export async function saveProgress(userId: string, input: ProgressInput) {
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${input.bookId}`}, 0))`,
    );
    const [ownedBook] = await transaction
      .select({
        durationMs: mediaAssets.durationMs,
        state: {
          userId: playbackStates.userId,
          bookId: playbackStates.bookId,
          positionMs: playbackStates.positionMs,
          playbackRate: playbackStates.playbackRate,
          completed: playbackStates.completed,
          deviceId: playbackStates.deviceId,
          deviceSequence: playbackStates.deviceSequence,
          eventOccurredAt: playbackStates.eventOccurredAt,
          updatedAt: playbackStates.updatedAt,
        },
      })
      .from(books)
      .innerJoin(mediaAssets, eq(mediaAssets.bookId, books.id))
      .leftJoin(
        playbackStates,
        and(eq(playbackStates.bookId, books.id), eq(playbackStates.userId, userId)),
      )
      .where(and(eq(books.id, input.bookId), eq(books.ownerId, userId)))
      .limit(1);
    if (!ownedBook) return { kind: "not-found" as const };
    const existing = ownedBook.state;

    const decision = decideProgressUpdate(existing, input.eventOccurredAt, new Date());
    if (!decision.accept) {
      // The sequence is still consumed so a replay of this event stays a
      // no-op instead of re-litigating the conflict later.
      const [sequenceClaim] = await transaction
        .insert(playbackDeviceSequences)
        .values({
          userId,
          bookId: input.bookId,
          deviceId: input.deviceId,
          lastSequence: input.deviceSequence,
        })
        .onConflictDoUpdate({
          target: [
            playbackDeviceSequences.userId,
            playbackDeviceSequences.bookId,
            playbackDeviceSequences.deviceId,
          ],
          set: { lastSequence: input.deviceSequence, updatedAt: new Date() },
          setWhere: lt(playbackDeviceSequences.lastSequence, input.deviceSequence),
        })
        .returning({ lastSequence: playbackDeviceSequences.lastSequence });
      if (!sequenceClaim) return { kind: "duplicate" as const, state: existing };
      return { kind: "conflict" as const, reason: decision.reason, state: existing };
    }

    const positionMs = Math.min(Math.max(0, input.positionMs), ownedBook.durationMs);
    const saved = await transaction.execute<PlaybackStateRow>(sql`
      with claimed as (
        insert into ${playbackDeviceSequences} ("user_id", "book_id", "device_id", "last_sequence")
        values (${userId}, ${input.bookId}, ${input.deviceId}, ${input.deviceSequence})
        on conflict ("user_id", "book_id", "device_id") do update
          set "last_sequence" = excluded."last_sequence", "updated_at" = now()
          where ${playbackDeviceSequences}."last_sequence" < excluded."last_sequence"
        returning "last_sequence"
      )
      insert into ${playbackStates} (
        "user_id", "book_id", "position_ms", "playback_rate", "completed",
        "device_id", "device_sequence", "event_occurred_at", "updated_at"
      )
      select ${userId}, ${input.bookId}::uuid, ${positionMs}::bigint,
        ${input.playbackRate.toFixed(2)}::numeric, ${input.completed}::boolean,
        ${input.deviceId}, ${input.deviceSequence}::bigint,
        ${decision.occurredAt.toISOString()}::timestamptz, now()
      from claimed
      on conflict ("user_id", "book_id") do update set
        "position_ms" = excluded."position_ms",
        "playback_rate" = excluded."playback_rate",
        "completed" = excluded."completed",
        "device_id" = excluded."device_id",
        "device_sequence" = excluded."device_sequence",
        "event_occurred_at" = excluded."event_occurred_at",
        "updated_at" = excluded."updated_at"
      returning
        "user_id" as "userId",
        "book_id" as "bookId",
        "position_ms"::float8 as "positionMs",
        "playback_rate" as "playbackRate",
        "completed",
        "device_id" as "deviceId",
        "device_sequence"::float8 as "deviceSequence",
        "event_occurred_at" as "eventOccurredAt",
        "updated_at" as "updatedAt"
    `);
    const state = saved[0];
    if (!state) return { kind: "duplicate" as const, state: existing };
    return { kind: "saved" as const, state };
  });
}
