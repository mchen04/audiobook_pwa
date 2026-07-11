import { eq } from "drizzle-orm";
import { z } from "zod";

import { auth } from "@/server/auth";
import { db } from "@/server/db/client";
import { user } from "@/server/db/schema";
import { withMutation } from "@/server/api/route-handler";

export const runtime = "nodejs";

const deleteSchema = z.object({
  confirmEmail: z.string().trim().min(3).max(320),
  currentPassword: z.string().min(12).max(128),
});

/**
 * Deletes the whole account: every table row cascades from the user record.
 * Audio bytes live only on the user's devices, so there are no server-side
 * objects to clean; the client wipes this device's local data afterward.
 */
export const POST = withMutation(
  deleteSchema,
  "Type your account email exactly to confirm deletion.",
  async ({ request, session, data }) => {
    if (data.confirmEmail.toLowerCase() !== session.user.email.toLowerCase()) {
      return Response.json(
        { error: "Type your account email exactly to confirm deletion." },
        { status: 400 },
      );
    }
    try {
      await auth.api.verifyPassword({
        headers: request.headers,
        body: { password: data.currentPassword },
      });
    } catch {
      return Response.json({ error: "The current password is incorrect." }, { status: 403 });
    }

    await db.delete(user).where(eq(user.id, session.user.id));

    // The session rows are already gone; this clears the browser cookie. Sign-out
    // can reject once the session row is deleted, so fall back to expiring the
    // cookie directly.
    let setCookie = "chapterline.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax";
    try {
      const signOutResponse = await auth.api.signOut({
        headers: request.headers,
        asResponse: true,
      });
      setCookie = signOutResponse.headers.get("Set-Cookie") || setCookie;
    } catch {
      // Keep the manual cookie expiry.
    }
    return Response.json({ deleted: true }, { status: 200, headers: { "Set-Cookie": setCookie } });
  },
);
