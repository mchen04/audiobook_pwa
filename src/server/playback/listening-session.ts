import "server-only";

import { getOwnedBook } from "@/server/books/queries";
import { db } from "@/server/db/client";
import { listeningSessions } from "@/server/db/schema";
import { isValidListeningSession } from "@/server/playback/listening-session-policy";
import { claimMutationReceipt } from "@/server/sync/mutation-receipt";

export type ListeningStretch = {
  startedAt: string;
  endedAt: string;
  startPositionMs: number;
  endPositionMs: number;
};

export type ListeningSessionOutcome = "recorded" | "duplicate" | "unknown-book" | "rejected";

/**
 * Records one contiguous listening stretch.
 *
 * Shared by the two routes that can receive one: `POST /api/books/:id/sessions`,
 * which the player used before the outbox existed and the parity suite still
 * calls directly, and `POST /api/books/:id/history`, which is where the outbox
 * replays every `history` mutation. Both must apply the same validity rules and
 * claim the same receipt, or the durable path and the direct path would disagree
 * about what counts as a listen.
 */
export async function recordListeningSession(
  userId: string,
  bookId: string,
  stretch: ListeningStretch,
  mutationId?: string,
): Promise<ListeningSessionOutcome> {
  const startedAt = new Date(stretch.startedAt);
  const endedAt = new Date(stretch.endedAt);
  const owned = await getOwnedBook(userId, bookId);
  if (!owned?.durationMs) return "unknown-book";
  if (
    !isValidListeningSession({
      ...stretch,
      startedAt,
      endedAt,
      durationMs: owned.durationMs,
    })
  ) {
    return "rejected";
  }
  const listenedMs = endedAt.getTime() - startedAt.getTime();

  // Listening sessions are append-only, so a replayed insert is a duplicate
  // row rather than a harmless no-op. The receipt claim and the insert share
  // one transaction: either the session exists and is recorded as applied, or
  // neither is true and the outbox retries.
  const duplicate = await db.transaction(async (transaction) => {
    if (mutationId) {
      const receipt = await claimMutationReceipt(transaction, { mutationId, userId, bookId });
      if (!receipt.claimed) return true;
    }
    await transaction.insert(listeningSessions).values({
      userId,
      bookId,
      startedAt,
      endedAt,
      startPositionMs: stretch.startPositionMs,
      endPositionMs: stretch.endPositionMs,
      listenedMs,
    });
    return false;
  });
  return duplicate ? "duplicate" : "recorded";
}

/** The one wire answer for a listening stretch, whichever route received it. */
export function listeningSessionResponse(outcome: ListeningSessionOutcome): Response {
  switch (outcome) {
    case "unknown-book":
      return Response.json({ error: "Not found" }, { status: 404 });
    case "rejected":
      return Response.json({ recorded: false }, { status: 422 });
    case "duplicate":
      return Response.json({ recorded: true, duplicate: true });
    default:
      return Response.json({ recorded: true, duplicate: false }, { status: 201 });
  }
}
