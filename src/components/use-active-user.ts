"use client";

import { useEffect, useSyncExternalStore } from "react";

import { ACTIVE_USER_KEY } from "@/lib/app-keys";

/**
 * The account this device is signed into.
 *
 * The server supplies it whenever it rendered the page. A warm launch is
 * served from Cache Storage and never reaches the server, so the device's own
 * `ACTIVE_USER_KEY` answers instead — and when there is no active user, the
 * only honest destination is `/login` (design contract section 8).
 */
export function useActiveUserId(serverUserId?: string): string | null {
  // `useSyncExternalStore` is what makes reading device storage safe under a
  // prerendered document: hydration uses the server's answer and the device's
  // answer arrives in the render straight after, with no markup mismatch.
  const stored = useSyncExternalStore(subscribe, readActiveUser, readNothing);
  const userId = serverUserId ?? stored;

  useEffect(() => {
    if (userId) return;
    // The hydration render always reports "no user" — it is the server's
    // answer, not the device's. Letting the task queue turn over first means
    // the device has answered before anyone is sent to the login page.
    const timer = window.setTimeout(() => window.location.replace("/login"), 0);
    return () => window.clearTimeout(timer);
  }, [userId]);

  return userId;
}

function subscribe(): () => void {
  return () => undefined;
}

function readActiveUser(): string | null {
  return localStorage.getItem(ACTIVE_USER_KEY);
}

function readNothing(): string | null {
  return null;
}
