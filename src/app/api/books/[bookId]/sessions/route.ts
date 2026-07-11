import { z } from "zod";

import { withMutationParams } from "@/server/api/route-handler";
import { getOwnedBook } from "@/server/books/queries";
import { db } from "@/server/db/client";
import { listeningSessions } from "@/server/db/schema";
import { isValidListeningSession } from "@/server/playback/listening-session-policy";

export const runtime = "nodejs";

const sessionSchema = z.object({
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  startPositionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  endPositionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
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

    await db.insert(listeningSessions).values({
      userId: session.user.id,
      bookId: params.bookId,
      startedAt,
      endedAt,
      startPositionMs: data.startPositionMs,
      endPositionMs: data.endPositionMs,
      listenedMs,
    });
    return Response.json({ recorded: true }, { status: 201 });
  },
);
