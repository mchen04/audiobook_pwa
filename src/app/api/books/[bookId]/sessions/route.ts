import { z } from "zod";

import { listeningSessionSchema } from "@/server/api/mutation-schemas";
import { withMutation } from "@/server/api/route-handler";
import {
  listeningSessionResponse,
  recordListeningSession,
} from "@/server/playback/listening-session";

export const runtime = "nodejs";

export const POST = withMutation(
  {
    params: z.object({ bookId: z.uuid() }),
    body: listeningSessionSchema,
    invalidBody: "Invalid listening session.",
  },
  async ({ session, params, data }) => {
    const { mutationId, ...stretch } = data;
    return listeningSessionResponse(
      await recordListeningSession(session.user.id, params.bookId, stretch, mutationId),
    );
  },
);
