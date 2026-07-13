import { z } from "zod";

import { PLAYBACK_ACTIONS } from "@/domain/playback-history";
import { isReasonablePlaybackActionTime } from "@/lib/playback-history-policy";
import { withMutationParams } from "@/server/api/route-handler";
import { savePlaybackAction } from "@/server/playback/history";

export const runtime = "nodejs";

const actionSchema = z.object({
  id: z.uuid(),
  action: z.enum(PLAYBACK_ACTIONS),
  positionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  previousPositionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  playbackRate: z.number().min(0.5).max(3),
  description: z.string().trim().min(1).max(160).nullable(),
  occurredAt: z.coerce.date(),
});

export const POST = withMutationParams(
  z.object({ bookId: z.uuid() }),
  actionSchema,
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
