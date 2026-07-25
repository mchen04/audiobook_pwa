import { z } from "zod";

import { isReasonablePlaybackActionTime } from "@/lib/playback-history-policy";
import { playbackActionSchema } from "@/server/api/mutation-schemas";
import { withMutationParams } from "@/server/api/route-handler";
import { savePlaybackAction } from "@/server/playback/history";

export const runtime = "nodejs";

export const POST = withMutationParams(
  z.object({ bookId: z.uuid() }),
  playbackActionSchema,
  "Invalid playback action.",
  async ({ session, params, data }) => {
    if (!isReasonablePlaybackActionTime(data.occurredAt)) {
      return Response.json(
        { error: "Playback action timestamp is too far ahead." },
        { status: 400 },
      );
    }
    const saved = await savePlaybackAction(session.user.id, { bookId: params.bookId, ...data });
    if (!saved) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ recordedAt: saved.recordedAt.toISOString() }, { status: 201 });
  },
);
