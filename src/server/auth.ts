import "server-only";

import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { db } from "@/server/db/client";
import { schema } from "@/server/db/schema";
import { env } from "@/server/env";
import {
  assertPasswordResetDeliveryConfigured,
  sendPasswordReset,
} from "@/server/mail/password-reset";

assertPasswordResetDeliveryConfigured();

export const auth = betterAuth({
  appName: "Chapterline",
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: 30 * 60,
    sendResetPassword: async ({ user, url }) => {
      await sendPasswordReset(user.email, url);
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 8 },
      "/sign-up/email": { window: 60 * 10, max: 5 },
      "/request-password-reset": { window: 60 * 10, max: 5 },
    },
  },
  advanced: {
    cookiePrefix: "chapterline",
    useSecureCookies: process.env.NODE_ENV === "production",
  },
  trustedOrigins: [env.BETTER_AUTH_URL],
});
