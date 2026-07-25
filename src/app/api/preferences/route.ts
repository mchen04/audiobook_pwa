import { eq } from "drizzle-orm";

import { DEFAULT_PREFERENCES } from "@/lib/preferences";
import { preferencesPatchSchema } from "@/server/api/mutation-schemas";
import { withMutation, withQuery } from "@/server/api/route-handler";
import { expectRow } from "@/server/books/queries";
import { db } from "@/server/db/client";
import { userPreferences } from "@/server/db/schema";

export const runtime = "nodejs";

export const GET = withQuery(async ({ session }) => {
  const [row] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, session.user.id))
    .limit(1);
  return Response.json({ preferences: row ? stripRow(row) : DEFAULT_PREFERENCES });
});

export const PATCH = withMutation(
  preferencesPatchSchema,
  "Invalid preferences.",
  async ({ session, data }) => {
    const row = expectRow(
      await db
        .insert(userPreferences)
        .values({ userId: session.user.id, ...DEFAULT_PREFERENCES, ...data })
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: { ...data, updatedAt: new Date() },
        })
        .returning(),
    );
    return Response.json({ preferences: stripRow(row) });
  },
);

function stripRow(row: typeof userPreferences.$inferSelect) {
  return {
    skipBackMs: row.skipBackMs,
    skipForwardMs: row.skipForwardMs,
    smartRewind: row.smartRewind,
    autoplayNextInCollection: row.autoplayNextInCollection,
  };
}
