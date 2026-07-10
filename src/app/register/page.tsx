import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { getSession } from "@/server/auth-session";

export const metadata: Metadata = { title: "Create account" };

export default async function RegisterPage() {
  if (await getSession()) redirect("/library");

  return (
    <AuthShell
      eyebrow="Private by default"
      title="Start your library"
      summary="One account, one private listening space. No profiles, friends, feeds, or sharing."
    >
      <AuthForm mode="register" />
    </AuthShell>
  );
}
