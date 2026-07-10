import { and, eq, lt } from "drizzle-orm";

import { expectRow } from "@/server/books/queries";
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

export async function saveProgress(userId: string, input: ProgressInput) {
  return db.transaction(async (transaction) => {
    const [ownedBook] = await transaction
      .select({ durationMs: mediaAssets.durationMs })
      .from(books)
      .innerJoin(mediaAssets, eq(mediaAssets.bookId, books.id))
      .where(and(eq(books.id, input.bookId), eq(books.ownerId, userId), eq(books.status, "ready")))
      .limit(1);
    if (!ownedBook) return { kind: "not-found" as const };

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

    const [existing] = await transaction
      .select()
      .from(playbackStates)
      .where(and(eq(playbackStates.userId, userId), eq(playbackStates.bookId, input.bookId)))
      .limit(1);

    if (!sequenceClaim) {
      return { kind: "duplicate" as const, state: existing || null };
    }

    const decision = decideProgressUpdate(existing || null, input.eventOccurredAt, new Date());
    if (!decision.accept) {
      return { kind: "conflict" as const, reason: decision.reason, state: existing || null };
    }

    const positionMs = Math.min(Math.max(0, input.positionMs), ownedBook.durationMs);
    const stateRows = await transaction
      .insert(playbackStates)
      .values({
        userId,
        bookId: input.bookId,
        positionMs,
        playbackRate: input.playbackRate.toFixed(2),
        completed: input.completed,
        deviceId: input.deviceId,
        deviceSequence: input.deviceSequence,
        eventOccurredAt: decision.occurredAt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [playbackStates.userId, playbackStates.bookId],
        set: {
          positionMs,
          playbackRate: input.playbackRate.toFixed(2),
          completed: input.completed,
          deviceId: input.deviceId,
          deviceSequence: input.deviceSequence,
          eventOccurredAt: decision.occurredAt,
          updatedAt: new Date(),
        },
      })
      .returning();

    return { kind: "saved" as const, state: expectRow(stateRows) };
  });
}
