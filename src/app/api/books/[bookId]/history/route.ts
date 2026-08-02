import { z } from "zod";

import { isReasonablePlaybackActionTime } from "@/lib/playback-history-policy";
import { playbackHistoryEventSchema } from "@/server/api/mutation-schemas";
import { withMutation } from "@/server/api/route-handler";
import { savePlaybackAction } from "@/server/playback/history";
import {
  listeningSessionResponse,
  recordListeningSession,
} from "@/server/playback/listening-session";

export const runtime = "nodejs";

/**
 * One book's listening history: the discrete actions the player records, and
 * the contiguous stretches the listening tracker measures.
 *
 * Both arrive here because the outbox carries both under its one `history`
 * mutation kind, and `history` is the kind that never coalesces — which is what
 * makes each event survive rather than collapse into the last one.
 */
export const POST = withMutation(
  {
    params: z.object({ bookId: z.uuid() }),
    body: playbackHistoryEventSchema,
    invalidBody: "Invalid playback history event.",
  },
  async ({ session, params, data }) => {
    if ("startedAt" in data) {
      const { id, ...stretch } = data;
      return listeningSessionResponse(
        await recordListeningSession(session.user.id, params.bookId, stretch, id),
      );
    }
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
