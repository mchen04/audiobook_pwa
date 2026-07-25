import { z } from "zod";

import { withMutationParams } from "@/server/api/route-handler";
import { getOwnedBook } from "@/server/books/queries";
import { db } from "@/server/db/client";
import { listeningSessions } from "@/server/db/schema";
import { isValidListeningSession } from "@/server/playback/listening-session-policy";
import { claimMutationReceipt } from "@/server/sync/mutation-receipt";

export const runtime = "nodejs";

const sessionSchema = z.object({
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  startPositionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  endPositionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /**
   * The outbox's idempotency key, generated once at queue time. Optional so
   * builds that predate the generalized outbox keep working; when it is absent
   * a replay can still double-insert, which is why the client always sends it.
   */
  mutationId: z.uuid().optional(),
});

export const POST = withMutationParams(
  z.object({ bookId: z.uuid() }),
  sessionSchema,
  "Invalid listening session.",
  async ({ session, params, data }) => {
    const startedAt = new Date(data.startedAt);
    const endedAt = new Date(data.endedAt);
    const owned = await getOwnedBook(session.user.id, params.bookId);
    if (!owned?.durationMs) return Response.json({ error: "Not found" }, { status: 404 });
    if (
      !isValidListeningSession({
        ...data,
        startedAt,
        endedAt,
        durationMs: owned.durationMs,
      })
    ) {
      return Response.json({ recorded: false }, { status: 422 });
    }
    const listenedMs = endedAt.getTime() - startedAt.getTime();

    // Listening sessions are append-only, so a replayed insert is a duplicate
    // row rather than a harmless no-op. The receipt claim and the insert share
    // one transaction: either the session exists and is recorded as applied, or
    // neither is true and the outbox retries.
    const duplicate = await db.transaction(async (transaction) => {
      if (data.mutationId) {
        const receipt = await claimMutationReceipt(transaction, {
          mutationId: data.mutationId,
          userId: session.user.id,
          bookId: params.bookId,
        });
        if (!receipt.claimed) return true;
      }
      await transaction.insert(listeningSessions).values({
        userId: session.user.id,
        bookId: params.bookId,
        startedAt,
        endedAt,
        startPositionMs: data.startPositionMs,
        endPositionMs: data.endPositionMs,
        listenedMs,
      });
      return false;
    });
    return Response.json({ recorded: true, duplicate }, { status: duplicate ? 200 : 201 });
  },
);
