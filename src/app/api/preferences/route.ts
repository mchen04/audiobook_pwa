import { eq } from "drizzle-orm";

import { DEFAULT_PREFERENCES, PREFERENCES_DEFAULTS_VERSION } from "@/domain/preferences";
import { withQuery } from "@/server/api/route-handler";
import { db } from "@/server/db/client";
import { userPreferences } from "@/server/db/schema";
import { makePreferencesPatch } from "@/server/preferences/patch-handler";
import { serializePlayerPreferences } from "@/server/preferences/write-policy";

export const runtime = "nodejs";

export const GET = withQuery(async ({ session }) => {
  const [row] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, session.user.id))
    .limit(1);
  return Response.json({
    preferences: row ? serializePlayerPreferences(row) : DEFAULT_PREFERENCES,
    defaultsVersion: PREFERENCES_DEFAULTS_VERSION,
  });
});

// The legacy path keeps accepting bare bodies so pre-v2 clients still work.
export const PATCH = makePreferencesPatch({ strict: false });
