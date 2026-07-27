"use client";

import { useCallback, useEffect, useState } from "react";

import {
  detectSuspendedSession,
  dismissSuspensionGap,
  readDismissedSuspensionGap,
  readLocalProgress,
  type SuspendedSession,
} from "@/lib/playback-core";

/**
 * "This was playing when the app went away, and nothing recorded what happened
 * next" — detected once per open, offered, never applied.
 *
 * WHY THIS EXISTS. `docs/resume-durability-device-check.md` states the one
 * durability question no instrument on a development machine can answer: while
 * a PWA is backgrounded with the screen off and audio playing, does iOS suspend
 * BOTH the 200 ms cadence timer AND the media element's `timeupdate`? The cost
 * if it does is measured — `tests/resume`'s both-writers-dead row loses 9644 ms
 * of a 9500 ms session, 100% of it, scaling linearly with the length of the
 * listen. We cannot find out whether iOS does this. We can make the app survive
 * it either way, and that is all this hook is.
 *
 * If iOS keeps either writer alive, the last durable record names that writer,
 * `detectSuspendedSession` returns null, and nothing is ever shown. This costs
 * one `localStorage` read per book open in the good case, and turns "lost the
 * whole screen-off listen" into one tap in the bad one.
 *
 * READ ONCE, AT OPEN, AND HELD. Two reasons, both deliberate.
 *
 *   The signature is destructible by the app itself. It says "nothing wrote
 *   after the hide edge", so the first cadence write of the new session erases
 *   it. Re-evaluating live would make the offer vanish the instant the user
 *   pressed play — exactly when they are most likely to notice the book is in
 *   the wrong place and want it.
 *
 *   The read must also beat that first write. This hook is called ABOVE the
 *   effect that calls `loadBook` in `full-player.tsx`, so its effect runs first
 *   and an `?autoplay=1` open cannot overwrite the record before it is seen.
 *
 * NOTHING HERE SEEKS. The hook reports and forgets; the caller owns the
 * control, and the user owns the press.
 */
export function useSuspensionRecovery({
  userId,
  bookId,
  durationMs,
}: {
  userId: string;
  bookId: string;
  durationMs: number;
}): { gap: SuspendedSession | null; dismiss: () => void } {
  const [gap, setGap] = useState<SuspendedSession | null>(null);

  useEffect(() => {
    // THE READ IS SYNCHRONOUS, and that is the load-bearing half. It has to
    // happen in the effect body itself, before any task can run: on an
    // `?autoplay=1` open the first `timeupdate` of the new session performs a
    // durable write — `writeDurableIfDue`'s gate is open on the first tick —
    // and that write is what erases the signature this is looking for.
    //
    // It is in an effect rather than in render because the server has no
    // `localStorage`, and computing this during render would hydrate a page
    // carrying the offer over server HTML that never had it.
    const detected = detectSuspendedSession({
      record: readLocalProgress(userId, bookId),
      durationMs,
    });
    // An answer the user has already given about THIS gap stands. A later
    // suspension carries a later `writtenAt` and is a different question.
    const answered =
      detected !== null && readDismissedSuspensionGap(userId, bookId) === detected.writtenAt;
    const next = answered ? null : detected;
    // THE RENDER UPDATE IS DEFERRED. A synchronous `setState` in an effect body
    // is a cascading render, and there is nothing to gain from one here: the
    // offer is not part of the first paint, and a microtask still lands long
    // before the `play`/`timeupdate` tasks above. `playback-provider` defers
    // its own cached-preferences read the same way and for the same reason.
    let live = true;
    queueMicrotask(() => {
      if (live) setGap(next);
    });
    return () => {
      live = false;
    };
  }, [bookId, durationMs, userId]);

  /**
   * This gap has been answered — by dismissing it, or by acting on it.
   *
   * Persisted rather than only cleared from state, because the offer is
   * evaluated at every open. Acting on it happens to destroy the signature too
   * (the seek writes a durable record of its own, so nothing still names the
   * hide edge), but that write is the one thing here allowed to fail — Safari
   * with storage blocked, a full quota — and a dismissal that depended on it
   * would bring the offer back on the next launch.
   */
  const dismiss = useCallback(() => {
    if (gap) dismissSuspensionGap(userId, bookId, gap.writtenAt);
    setGap(null);
  }, [bookId, gap, userId]);

  return { gap, dismiss };
}
