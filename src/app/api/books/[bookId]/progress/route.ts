import { z } from "zod";

import { withMutationParams } from "@/server/api/route-handler";
import { saveProgress } from "@/server/playback/progress";

export const runtime = "nodejs";

const progressSchema = z.object({
  deviceId: z.string().min(16).max(100),
  deviceSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  positionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  playbackRate: z.number().min(0.5).max(3),
  completed: z.boolean(),
  eventOccurredAt: z.coerce.date(),
});

export const PATCH = withMutationParams(
  z.object({ bookId: z.uuid() }),
  progressSchema,
  "Invalid progress update.",
  async ({ session, params, data }) => {
    const result = await saveProgress(session.user.id, { bookId: params.bookId, ...data });
    if (result.kind === "not-found") return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(result, { status: result.kind === "conflict" ? 409 : 200 });
  },
);
