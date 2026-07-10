import { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { requireSession } from "@/server/auth-session";

export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  return (
    <AppShell userId={session.user.id} email={session.user.email}>
      {children}
    </AppShell>
  );
}
