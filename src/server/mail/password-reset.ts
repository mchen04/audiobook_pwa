import "server-only";

import { env } from "@/server/env";

import { capturePasswordReset } from "./local-mailer";

export function assertPasswordResetDeliveryConfigured(): void {
  if (!!env.RESEND_API_KEY !== !!env.MAIL_FROM) {
    throw new Error("Password reset email requires both RESEND_API_KEY and MAIL_FROM.");
  }
}

export async function sendPasswordReset(email: string, url: string): Promise<void> {
  if (env.RESEND_API_KEY && env.MAIL_FROM) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [email],
        subject: "Reset your Hark password",
        text: `Reset your Hark password:\n\n${url}\n\nThis link expires in 30 minutes.`,
      }),
    });
    if (!response.ok) throw new Error("Password reset email delivery failed.");
    return;
  }
  if (process.env.NODE_ENV !== "production" || env.ALLOW_LOCAL_MAIL_CAPTURE === "true") {
    await capturePasswordReset(email, url);
    return;
  }
  throw new Error("Password reset delivery is not configured.");
}
