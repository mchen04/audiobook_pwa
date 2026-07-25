"use client";

import { createAuthClient } from "better-auth/react";

import { ACTIVE_USER_KEY } from "@/lib/app-keys";

/**
 * Account lifecycle purge is wired here rather than in the sign-in and
 * sign-out components so that no future call site can forget it: every
 * successful auth request passes through this one hook.
 *
 * Both directions run (`docs/local-first.md` section 11) — purging on sign-in
 * as well as sign-out is what covers a crash between the two.
 */

type AuthSuccessContext = {
  request?: { url?: string | URL };
  data?: unknown;
};

function pathOf(context: AuthSuccessContext): string {
  const url = context.request?.url;
  if (!url) return "";
  try {
    return new URL(url, "https://placeholder.invalid").pathname;
  } catch {
    return "";
  }
}

function signedInUserId(data: unknown): string | null {
  const user = (data as { user?: { id?: unknown } } | null)?.user;
  return typeof user?.id === "string" ? user.id : null;
}

export async function runAccountPurge(context: AuthSuccessContext): Promise<void> {
  if (typeof window === "undefined") return;
  const path = pathOf(context);
  if (!path) return;
  const purge = await import("@/lib/offline/account-purge");

  if (path.endsWith("/sign-out")) {
    // Read before the caller clears it: this is the account being left.
    const userId = localStorage.getItem(ACTIVE_USER_KEY);
    if (userId) await purge.purgeOnSignOut(userId);
    else await purge.purgeCachedPages();
    return;
  }

  if (path.includes("/sign-in") || path.includes("/sign-up")) {
    const userId = signedInUserId(context.data);
    if (userId) await purge.purgeOnSignIn(userId);
  }
}

export const authClient = createAuthClient({
  fetchOptions: {
    onSuccess: (context: AuthSuccessContext) => {
      // A storage failure must never turn a successful sign-in into a failed
      // one; the next launch retries the sweep.
      void runAccountPurge(context).catch(() => undefined);
    },
  },
});
