import { z } from "zod";

import { withMutation } from "@/server/api/route-handler";
import { getOwnedBook } from "@/server/books/queries";
import { db } from "@/server/db/client";
import { listeningSessions } from "@/server/db/schema";

export const runtime = "nodejs";

const MIN_SESSION_MS = 5_000;
const MAX_SESSION_MS = 24 * 60 * 60 * 1000;

const sessionSchema = z.object({
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  startPositionMs: z.number().int().nonnegative(),
  endPositionMs: z.number().int().nonnegative(),
});

export const POST = withMutation<typeof sessionSchema, { bookId: string }>(
  sessionSchema,
  "Invalid listening session.",
  async ({ session, params, data }) => {
    const startedAt = new Date(data.startedAt);
    const endedAt = new Date(data.endedAt);
    const listenedMs = endedAt.getTime() - startedAt.getTime();
    if (listenedMs < MIN_SESSION_MS || listenedMs > MAX_SESSION_MS) {
      return Response.json({ recorded: false });
    }

    const owned = await getOwnedBook(session.user.id, params.bookId);
    if (!owned) return Response.json({ error: "Not found" }, { status: 404 });

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
