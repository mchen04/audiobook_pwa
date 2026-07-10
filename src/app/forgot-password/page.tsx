import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { getSession } from "@/server/auth-session";

export const metadata: Metadata = { title: "Reset password" };

export default async function ForgotPasswordPage() {
  if (await getSession()) redirect("/library");

  return (
    <AuthShell
      eyebrow="Account recovery"
      title="Reset your password"
      summary="Enter your account email and we will send a link that lets you choose a new password."
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}
