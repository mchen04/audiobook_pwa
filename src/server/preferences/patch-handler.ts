import "server-only";

import { and, eq } from "drizzle-orm";

import {
  DEFAULT_PREFERENCES,
  isPreferenceWriteId,
  PREFERENCES_DEFAULTS_HEADER,
  PREFERENCES_DEFAULTS_VERSION,
  PREFERENCES_LEGACY_REPLAY_HEADER,
  PREFERENCES_WRITE_ID_HEADER,
} from "@/domain/preferences";
import { preferencesPatchSchema } from "@/server/api/mutation-schemas";
import { withMutation } from "@/server/api/route-handler";
import { expectRow } from "@/server/books/queries";
import { db } from "@/server/db/client";
import {
  preferenceWriteReceipts,
  session as authSession,
  userPreferences,
} from "@/server/db/schema";
import {
  applyPreferenceWritePolicy,
  serializePlayerPreferences,
} from "@/server/preferences/write-policy";

/**
 * One PATCH implementation behind two routes. `/api/preferences/v2` is strict:
 * it demands the full write protocol (a version or legacy-replay header plus a
 * write id), while the legacy `/api/preferences` path keeps accepting bare
 * bodies from pre-v2 clients. Each route file configures its own handler here
 * so the behavior split lives in the route, not in URL sniffing.
 */
export function makePreferencesPatch({ strict }: { strict: boolean }) {
  return withMutation(
    { body: preferencesPatchSchema, invalidBody: "Invalid preferences." },
    async ({ request, session, data }) => {
      const defaultsVersionHeader = request.headers.get(PREFERENCES_DEFAULTS_HEADER);
      const legacyReplayHeader = request.headers.get(PREFERENCES_LEGACY_REPLAY_HEADER);
      const writeIdHeader = request.headers.get(PREFERENCES_WRITE_ID_HEADER);
      const currentProtocol = defaultsVersionHeader === String(PREFERENCES_DEFAULTS_VERSION);
      const legacyReplayProtocol = defaultsVersionHeader === null && legacyReplayHeader === "1";
      if (strict && ((!currentProtocol && !legacyReplayProtocol) || writeIdHeader === null)) {
        return Response.json({ error: "Incomplete preference write protocol." }, { status: 400 });
      }
      if (writeIdHeader !== null && !isPreferenceWriteId(writeIdHeader)) {
        return Response.json({ error: "Invalid preference write id." }, { status: 400 });
      }
      const policy = applyPreferenceWritePolicy(data, defaultsVersionHeader);
      const update: Partial<typeof userPreferences.$inferInsert> = {
        ...policy.patch,
        updatedAt: new Date(),
      };
      if (policy.smartRewindExplicit !== undefined) {
        update.smartRewindExplicit = policy.smartRewindExplicit;
      }
      const result = await db.transaction(async (transaction) => {
        // Serialize this write with revocation of the session that authorized it.
        // If sign-out deletes the row first, an already-authenticated request is
        // rejected. If this lock wins first, sign-out cannot finish until this
        // transaction commits, so a later same-account sign-in cannot be
        // overwritten by work from the departed session.
        const [originatingSession] = await transaction
          .select({ id: authSession.id })
          .from(authSession)
          .where(
            and(eq(authSession.id, session.session.id), eq(authSession.userId, session.user.id)),
          )
          .limit(1)
          .for("update");
        if (!originatingSession) return { revoked: true as const };

        if (writeIdHeader) {
          const [receipt] = await transaction
            .insert(preferenceWriteReceipts)
            .values({
              userId: session.user.id,
              writeId: writeIdHeader,
              appliedPatch: data,
            })
            .onConflictDoNothing({
              target: [preferenceWriteReceipts.userId, preferenceWriteReceipts.writeId],
            })
            .returning({ appliedPatch: preferenceWriteReceipts.appliedPatch });
          if (!receipt) {
            const [existingReceipt] = await transaction
              .select({ appliedPatch: preferenceWriteReceipts.appliedPatch })
              .from(preferenceWriteReceipts)
              .where(
                and(
                  eq(preferenceWriteReceipts.userId, session.user.id),
                  eq(preferenceWriteReceipts.writeId, writeIdHeader),
                ),
              )
              .limit(1);
            const [current] = await transaction
              .select()
              .from(userPreferences)
              .where(eq(userPreferences.userId, session.user.id))
              .limit(1);
            return {
              revoked: false as const,
              row: current ?? null,
              acknowledgedPatch: existingReceipt?.appliedPatch ?? null,
            };
          }
        }
        const row = expectRow(
          await transaction
            .insert(userPreferences)
            .values({
              userId: session.user.id,
              ...DEFAULT_PREFERENCES,
              ...policy.patch,
              smartRewindExplicit: policy.smartRewindExplicit ?? false,
            })
            .onConflictDoUpdate({
              target: userPreferences.userId,
              set: update,
            })
            .returning(),
        );
        return { revoked: false as const, row, acknowledgedPatch: data };
      });
      if (result.revoked) {
        return Response.json({ error: "Session expired." }, { status: 401 });
      }
      return Response.json({
        preferences: result.row ? serializePlayerPreferences(result.row) : DEFAULT_PREFERENCES,
        defaultsVersion: PREFERENCES_DEFAULTS_VERSION,
        acknowledgedWriteId: writeIdHeader,
        acknowledgedPatch: result.acknowledgedPatch,
      });
    },
  );
}
