"use client";

import { createAuthClient } from "better-auth/react";

import { ACTIVE_USER_KEY } from "@/lib/app-keys";
import type { UndeliveredWrite } from "@/lib/offline/account-purge";

/**
 * Account lifecycle purge is wired here rather than in the sign-in and
 * sign-out components so that no future call site can forget it: every
 * successful auth request passes through this one hook.
 *
 * Both directions run (`docs/local-first.md` section 11) — purging on sign-in
 * as well as sign-out is what covers a crash between the two.
 *
 * SIGN-OUT IS THREE PHASES, and the order of them is the whole design:
 *
 *  1. `onRequest` — the outbox is drained BEFORE the sign-out request is sent,
 *     because that is the last instant the session cookie the replay needs is
 *     still valid. Drain it in `onSuccess` and every write gets a 401.
 *  2. the request itself.
 *  3. `onSuccess` — the departing account's identity is read SYNCHRONOUSLY,
 *     before any `await`, and the sweep is AWAITED. Both halves are load-bearing.
 *     `@/lib/offline/account-purge` has no static importer, so in a production
 *     build it is a separate chunk and `await import(...)` is a real network
 *     fetch; reading `ACTIVE_USER_KEY` after it let the caller's own
 *     `removeItem` win the race, at which point the purge saw `null`, swept
 *     only the page cache, and left the mirror, the downloaded MP3s, the
 *     outbox, the history and the deletion journal on the device. And firing it
 *     unawaited let the caller navigate away mid-sweep.
 *
 * SIGN-IN IS ALSO AWAITED, with a bound. It is the crash-recovery path — the
 * thing that finishes a purge an earlier sign-out never completed — so running
 * it unawaited meant the incoming account's library painted over a sweep still
 * in progress, and a closed tab abandoned it entirely. See
 * `SIGN_IN_PURGE_TIMEOUT_MS` for why the wait is bounded rather than absolute.
 */

type AuthSuccessContext = {
  request?: { url?: string | URL };
  data?: unknown;
};

type AuthRequestContext = {
  url?: string | URL;
  method?: string;
};

/** What the last sign-out did, for the UI that has to tell the user about it. */
export type SignOutReport = {
  /** Writes that never reached the server and are no longer on this device. */
  undelivered: UndeliveredWrite[];
  /** A purge step that failed; the next sign-in sweeps whatever it left. */
  purgeFailed: boolean;
};

function pathOf(context: AuthSuccessContext | AuthRequestContext): string {
  const url = "request" in context ? context.request?.url : (context as AuthRequestContext).url;
  if (!url) return "";
  try {
    return new URL(url, "https://placeholder.invalid").pathname;
  } catch {
    return "";
  }
}

function isSignOut(path: string): boolean {
  return path.endsWith("/sign-out");
}

function signedInUserId(data: unknown): string | null {
  const user = (data as { user?: { id?: unknown } } | null)?.user;
  return typeof user?.id === "string" ? user.id : null;
}

/**
 * What phase 1 learned, handed to phase 3. `ran` is separate from an empty list
 * on purpose: "the drain found nothing to report" and "the drain never happened"
 * are opposite facts, and only the first one means the queue is safe to drop.
 */
let signOutDrain: { ran: boolean; undelivered: UndeliveredWrite[] } = {
  ran: false,
  undelivered: [],
};
let signOutReport: SignOutReport | null = null;
let purgeInFlight: Promise<void> = Promise.resolve();
let purgeGate: Promise<void> = Promise.resolve();

/**
 * How long a sign-in will wait for the crash-recovery sweep before it lets the
 * user in anyway.
 *
 * Bounded for the same reason `SIGN_OUT_DRAIN_TIMEOUT_MS` is: a storage layer
 * that has wedged — a blocked IndexedDB upgrade held by another tab, a Cache
 * Storage call that never settles — must not lock somebody out of their own
 * account. Unbounded is not safer here, because the sweep is idempotent and
 * records no progress: `purgeOnSignIn` re-enumerates every local account from
 * the three databases each time it runs, so whatever this bound abandons is
 * found again by the next sign-in. Waiting forever would trade a recoverable
 * delay for an unrecoverable lockout.
 *
 * Five seconds rather than the drain's eight: this sweep is local storage work
 * with no network in it, so anything slower than this is wedged rather than
 * slow, and unlike the drain there is nothing here that a few more seconds of
 * patience could still deliver.
 */
export const SIGN_IN_PURGE_TIMEOUT_MS = 5_000;

function bounded(work: Promise<void>, timeoutMs: number): Promise<void> {
  let expire: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    expire = setTimeout(resolve, timeoutMs);
  });
  // Raced, not aborted: the sweep keeps deleting after the bound expires, and
  // the caller can still await the real thing via `whenAccountPurgeSettled`.
  return Promise.race([work, bound]).finally(() => clearTimeout(expire));
}

/**
 * Reads and clears the report. Consuming it is deliberate: the caller that
 * takes it owns telling the user, and a second reader must not show the same
 * warning twice.
 */
export function takeSignOutReport(): SignOutReport | null {
  const report = signOutReport;
  signOutReport = null;
  return report;
}

/** The sweep itself: resolves only once it has actually finished. */
export function whenAccountPurgeSettled(): Promise<void> {
  return purgeInFlight;
}

/**
 * What a caller may navigate on. Sign-out waits for the whole sweep; sign-in
 * waits for it too, but gives up after `SIGN_IN_PURGE_TIMEOUT_MS` rather than
 * refusing to let the user into their account.
 *
 * The auth hook already awaits this before its request resolves, so awaiting
 * it again at a call site costs nothing — it is the same promise, not a second
 * bound — and keeps the guarantee visible where the navigation is written.
 */
export function whenAccountPurgeGateOpen(): Promise<void> {
  return purgeGate;
}

/**
 * Phase 1. Runs before the sign-out request leaves the device, while the
 * session is still good, and records anything the server would not take.
 */
async function runSignOutDrain(context: AuthRequestContext): Promise<void> {
  if (typeof window === "undefined") return;
  if (!isSignOut(pathOf(context))) return;
  signOutDrain = { ran: false, undelivered: [] };
  const userId = localStorage.getItem(ACTIVE_USER_KEY);
  if (!userId) return;
  const purge = await import("@/lib/offline/account-purge");
  signOutDrain = { ran: true, undelivered: await purge.drainBeforeSignOut(userId) };
}

export async function runAccountPurge(context: AuthSuccessContext): Promise<void> {
  if (typeof window === "undefined") return;
  const path = pathOf(context);
  if (!path) return;

  if (isSignOut(path)) {
    // Read BEFORE the dynamic import, and before anything else can await: this
    // is the account being left, and the caller is free to clear the key the
    // moment `signOut()` resolves.
    const userId = localStorage.getItem(ACTIVE_USER_KEY);
    const drain = signOutDrain;
    signOutDrain = { ran: false, undelivered: [] };
    const purge = await import("@/lib/offline/account-purge");
    if (!userId) {
      signOutReport = { undelivered: drain.undelivered, purgeFailed: false };
      await purge.purgeCachedPages();
      return;
    }
    // A drain that already ran is handed over rather than repeated: the session
    // is dead by now, so a second pass could only fail, burn the bound again,
    // and report the same write twice.
    const outcome = await purge.purgeOnSignOut(
      userId,
      drain.ran ? { alreadyDrained: drain.undelivered } : {},
    );
    signOutReport = { undelivered: outcome.undelivered, purgeFailed: !!outcome.failure };
    if (outcome.failure) throw outcome.failure;
    return;
  }

  if (path.includes("/sign-in") || path.includes("/sign-up")) {
    const purge = await import("@/lib/offline/account-purge");
    const userId = signedInUserId(context.data);
    if (userId) await purge.purgeOnSignIn(userId);
  }
}

/**
 * The two hooks, exported so they can be exercised as the auth client will
 * actually call them rather than re-declared by a test.
 */
export const authFetchHooks = {
  onRequest: async (context: AuthRequestContext) => {
    // A drain failure must never stop somebody signing out; whatever it could
    // not deliver is still counted by the sweep below and reported.
    await runSignOutDrain(context).catch(() => undefined);
  },
  onSuccess: async (context: AuthSuccessContext) => {
    purgeInFlight = runAccountPurge(context).catch(() => undefined);
    // BOTH directions are awaited, and better-fetch awaits this hook before the
    // auth call resolves, so no call site can navigate mid-sweep.
    //
    // Sign-out waits for the whole thing: `signOut()` must not resolve — and
    // the caller must not clear `ACTIVE_USER_KEY` — while the departing
    // account's library is still on the device. A storage failure must never
    // turn a successful sign-out into a failed one, so it is reported through
    // `takeSignOutReport()` rather than thrown; the next launch retries.
    //
    // Sign-in waits BOUNDED. It was fire-and-forget, which meant account B's
    // library painted while account A's mirror and downloaded MP3s were still
    // being deleted, and closing the tab abandoned the sweep — in the one path
    // whose entire job is finishing a purge an earlier crash interrupted.
    purgeGate = isSignOut(pathOf(context))
      ? purgeInFlight
      : bounded(purgeInFlight, SIGN_IN_PURGE_TIMEOUT_MS);
    await purgeGate;
  },
};

export const authClient = createAuthClient({ fetchOptions: authFetchHooks });
