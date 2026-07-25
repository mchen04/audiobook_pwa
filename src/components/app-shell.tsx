"use client";

import { ReactNode } from "react";
import { DownloadSimple, GearSix } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { AccountMenu } from "@/components/account-menu";
import { BrandMark } from "@/components/brand-mark";
import { MiniPlayer } from "@/components/player/mini-player";
import { PlaybackProvider } from "@/components/player/playback-provider";
import { useActiveUserId } from "@/components/use-active-user";

/**
 * The one chrome the app has. A server-rendered page passes the session it
 * already loaded; a warm launch served from Cache Storage has no session in
 * hand, so the shell resolves the device's active user and shows the
 * account-agnostic header — the same chrome, minus what only the server knows.
 */
export function AppShell({
  userId: serverUserId,
  email,
  children,
}: {
  userId?: string;
  email?: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const userId = useActiveUserId(serverUserId);
  // The player brings its own topbar with a back button; on phones the
  // global header would just duplicate chrome above it.
  const onPlayerPage = pathname.startsWith("/books/");

  if (!userId) return <main className="app-page" />;

  return (
    <PlaybackProvider userId={userId}>
      <main className="app-page">
        <header className={`app-header ${onPlayerPage ? "app-header-collapsible" : ""}`}>
          <BrandMark />
          {/* These links do not prefetch: speculatively fetching /settings and
              a second copy of /library on every launch puts server round trips
              and their session lookups back on the launch path for screens
              nobody asked for. */}
          <div className="app-actions">
            {/* Downloads is a facet of the library now, not a screen of its own. */}
            <Link href="/library?device=1" className="icon-text-button" prefetch={false}>
              <DownloadSimple size={19} aria-hidden="true" />
              <span>Downloads</span>
            </Link>
            {email ? (
              <AccountMenu email={email} />
            ) : (
              <Link href="/settings" className="icon-text-button" prefetch={false}>
                <GearSix size={19} aria-hidden="true" />
                <span>Settings</span>
              </Link>
            )}
          </div>
        </header>
        {children}
      </main>
      <MiniPlayer />
    </PlaybackProvider>
  );
}
