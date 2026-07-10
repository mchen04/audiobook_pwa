import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { getSession } from "@/server/auth-session";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getSession()) redirect("/library");

  return (
    <AuthShell
      eyebrow="Welcome back"
      title="Sign in to your library"
      summary="Your listening position and private books stay connected across your devices."
    >
      <AuthForm mode="login" />
    </AuthShell>
  );
}
