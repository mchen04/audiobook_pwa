import { z } from "zod";

import { progressSchema } from "@/server/api/mutation-schemas";
import { withMutation } from "@/server/api/route-handler";
import { saveProgress } from "@/server/playback/progress";

export const runtime = "nodejs";

export const PATCH = withMutation(
  {
    params: z.object({ bookId: z.uuid() }),
    body: progressSchema,
    invalidBody: "Invalid progress update.",
  },
  async ({ session, params, data }) => {
    const result = await saveProgress(session.user.id, { bookId: params.bookId, ...data });
    if (result.kind === "not-found") return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(result, { status: result.kind === "conflict" ? 409 : 200 });
  },
);
