import type { Metadata } from "next";

import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { AuthShell } from "@/components/auth/auth-shell";

export const metadata: Metadata = { title: "Choose a new password" };

export default function ResetPasswordPage() {
  return (
    <AuthShell
      eyebrow="Account recovery"
      title="Choose a new password"
      summary="Set a new password for your account. Existing sessions are signed out for safety."
    >
      <ResetPasswordForm />
    </AuthShell>
  );
}
