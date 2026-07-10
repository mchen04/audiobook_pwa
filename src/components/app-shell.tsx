"use client";

import { ReactNode } from "react";
import { DownloadSimple } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { AccountMenu } from "@/components/account-menu";
import { BrandMark } from "@/components/brand-mark";
import { MiniPlayer } from "@/components/player/mini-player";
import { PlaybackProvider } from "@/components/player/playback-provider";

export function AppShell({
  userId,
  email,
  children,
}: {
  userId: string;
  email: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  // The player brings its own topbar with a back button; on phones the
  // global header would just duplicate chrome above it.
  const onPlayerPage = pathname.startsWith("/books/");
  return (
    <PlaybackProvider userId={userId}>
      <main className="app-page">
        <header className={`app-header ${onPlayerPage ? "app-header-collapsible" : ""}`}>
          <BrandMark />
          <div className="app-actions">
            <Link href="/offline" className="icon-text-button">
              <DownloadSimple size={19} aria-hidden="true" />
              <span>Downloads</span>
            </Link>
            <AccountMenu email={email} />
          </div>
        </header>
        {children}
      </main>
      <MiniPlayer />
    </PlaybackProvider>
  );
}
