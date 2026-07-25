import { z } from "zod";

import { listeningSessionSchema } from "@/server/api/mutation-schemas";
import { withMutationParams } from "@/server/api/route-handler";
import {
  listeningSessionResponse,
  recordListeningSession,
} from "@/server/playback/listening-session";

export const runtime = "nodejs";

export const POST = withMutationParams(
  z.object({ bookId: z.uuid() }),
  listeningSessionSchema,
  "Invalid listening session.",
  async ({ session, params, data }) => {
    const { mutationId, ...stretch } = data;
    return listeningSessionResponse(
      await recordListeningSession(session.user.id, params.bookId, stretch, mutationId),
    );
  },
);
