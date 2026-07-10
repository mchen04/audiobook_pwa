import type { Metadata } from "next";

import { SettingsClient } from "@/components/settings/settings-client";
import { requireSession } from "@/server/auth-session";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const session = await requireSession();
  return <SettingsClient email={session.user.email} />;
}
