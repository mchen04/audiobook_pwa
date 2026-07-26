import { z } from "zod";

import { withQuery } from "@/server/api/route-handler";
import { loadPullBatch } from "@/server/sync/pull";

export const runtime = "nodejs";

const sinceSchema = z.iso.datetime();

/**
 * Everything that changed for the signed-in user since `?since=<iso>`, as the
 * book and collection aggregates of `docs/local-first.md` section 3. Omitting
 * `since` requests a full sync.
 */
export const GET = withQuery(async ({ request, session }) => {
  const since = new URL(request.url).searchParams.get("since");
  if (since !== null && !sinceSchema.safeParse(since).success) {
    return Response.json({ error: "Invalid sync cursor." }, { status: 400 });
  }
  // The cursor is passed through as the text the server issued: parsing it into
  // a Date would truncate the microseconds it needs to stay strictly ahead of
  // the rows it has already covered.
  return Response.json(await loadPullBatch(session.user.id, since));
});
