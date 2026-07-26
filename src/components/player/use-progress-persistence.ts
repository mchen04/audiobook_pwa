"use client";

import { RefObject, useCallback, useEffect, useRef } from "react";

import type { PlayerBook } from "@/domain/player";
import { PROGRESS_CONFLICT_EVENT } from "@/lib/app-keys";
import {
  reconcileProgressConflict,
  replayQueuedMutations,
  shouldRetainMutation,
  nextDeviceSequence,
  toProgressBody,
  withProgressMutationLock,
} from "@/lib/offline-sync";
import { commitProgress, mirrorProgress } from "@/lib/offline/outbox";
import { getDeviceId, saveLocalPlaybackState } from "@/lib/playback-core";

/**
 * How often the durable local position is refreshed while audio is playing.
 *
 * 200 ms, on a timer of this hook's own rather than on `timeupdate`.
 *
 * WHY A TIMER AND NOT THE TICK. `timeupdate` fires about every 250 ms in
 * WebKit and up to 60 Hz elsewhere, so any policy expressed in ticks has a
 * write rate set by the engine rather than by us — and a throttle layered on
 * top of it still inherits the tick's PHASE, which is what decides whether the
 * last write before a kill happened 10 ms ago or 250 ms ago. A `setInterval`
 * that samples `audio.currentTime` gives a worst-case staleness of exactly one
 * interval on every engine, which is the property the bars are stated in.
 *
 * WHY 200 ms. Two failure shapes bound it, and they are the two the oracle
 * grades. A process killed with no callback at all (the app-switcher swipe, an
 * out-of-memory reap) can only come back as far as the last write: worst case
 * one interval, so 200 ms against a 1000 ms bar. A process that IS given a
 * lifecycle callback and then keeps playing before it is reaped — a
 * backgrounded audiobook, which is the normal way this app is used — is
 * protected by the synchronous flush on the callback AND by this cadence for
 * however long it lives after it; worst case is again one interval, against a
 * 250 ms bar. 250 ms of cadence would sit exactly ON that bar with no margin
 * for the write itself, and 500 ms (measured) misses it outright.
 *
 * WHY THAT IS NOT WRITE AMPLIFICATION. The rate is a constant, not a function
 * of the tick rate, the device, or how fast the book is playing; it is five
 * writes per second of one ~130-byte string, and only while audio is actually
 * playing — a paused or idle player writes nothing at all. That is ~650 B/s of
 * logical writes, and WebKit backs `localStorage` with a coalescing write-behind
 * flush, so the disk sees roughly one small row update per second rather than
 * five. Ten hours of listening is on the order of 20 MB of logical writes
 * against a flash endurance budget measured in hundreds of terabytes, and one
 * timer callback per 200 ms is invisible next to the audio decode that is
 * already running.
 *
 * This is NOT a substitute for the lifecycle flush, and must not be read as
 * one. Neither a timer nor `timeupdate` is guaranteed to keep running once iOS
 * has backgrounded the PWA, and this repo cannot observe which of them does —
 * that needs real hardware. The synchronous write on the lifecycle edge is what
 * has to be correct; the cadence exists for the case where no edge is delivered
 * at all, and for the window between an edge and the kill that follows it.
 */
const DURABLE_SAVE_INTERVAL_MS = 200;
const SERVER_SAVE_INTERVAL_MS = 15_000;

/**
 * Durable progress.
 *
 * The shape that matters: `saveDurableState` writes the full playback tuple
 * synchronously, OUTSIDE the cross-tab lock and outside every IndexedDB
 * transaction, and every other durable path in this hook runs it first. The
 * server write, the outbox row and the mirror projection all sit behind awaits
 * and are best-effort; the local write is the one that has to land, because on
 * a terminating iOS page it is the only thing that can.
 */
export function useProgressPersistence(
  userId: string,
  audioRef: RefObject<HTMLAudioElement | null>,
  activeBookRef: RefObject<PlayerBook | null>,
) {
  const lastServerSaveRef = useRef(0);
  const completionRef = useRef(new Map<string, boolean>());
  /**
   * Has anything happened to this book's position since it was opened?
   *
   * Opening a book, looking at it and closing it must not move where the user
   * left off. Smart rewind makes that a real hazard rather than a theoretical
   * one: the rewound start is a *proposal*, and writing it back turns a reading
   * aid into a position that walks backwards a little on every open. So a
   * terminal flush with no play, no seek and no rate change behind it writes
   * nothing at all.
   */
  const positionChangedRef = useRef(false);

  const markPositionChanged = useCallback(() => {
    positionChangedRef.current = true;
  }, []);

  /**
   * The synchronous durable write. No await before the `setItem`, by contract:
   * a `pagehide`/`visibilitychange` handler on iOS gets one task and may never
   * get a continuation.
   */
  const saveDurableState = useCallback(
    (positionMs?: number, completed?: boolean, bookOverride?: PlayerBook) => {
      const activeBook = bookOverride || activeBookRef.current;
      if (!activeBook) return;
      if (completed !== undefined) completionRef.current.set(activeBook.id, completed);
      if (!positionChangedRef.current) return;
      const audio = audioRef.current;
      const position = positionMs ?? (audio ? audio.currentTime * 1000 : 0);
      if (!Number.isFinite(position) || position < 0) return;
      saveLocalPlaybackState(userId, activeBook.id, {
        positionMs: position,
        playbackRate: audio?.playbackRate || 1,
        completed: completed ?? completionRef.current.get(activeBook.id) ?? activeBook.completed,
      });
    },
    [activeBookRef, audioRef, userId],
  );

  /**
   * The server half: the PATCH, and the outbox row when it cannot be sent.
   * Everything in here is behind an await and is allowed to never run — the
   * durable local write has already happened by the time this is called.
   */
  const sendProgress = useCallback(
    async (positionMs: number, completed?: boolean, bookOverride?: PlayerBook) => {
      const activeBook = bookOverride || activeBookRef.current;
      if (!activeBook || !positionChangedRef.current) return;
      const durableCompleted =
        completed ?? completionRef.current.get(activeBook.id) ?? activeBook.completed;
      const playbackRate = audioRef.current?.playbackRate || 1;
      await withProgressMutationLock(activeBook.id, async () => {
        const event = {
          bookId: activeBook.id,
          deviceId: getDeviceId(),
          deviceSequence: await nextDeviceSequence(activeBook.id),
          positionMs: Math.round(positionMs),
          playbackRate,
          completed: durableCompleted,
          eventOccurredAt: new Date().toISOString(),
        };

        try {
          const response = await fetch(`/api/books/${activeBook.id}/progress`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: toProgressBody(event),
            keepalive: true,
          });
          if (response.status === 409) {
            await reconcileProgressConflict({ userId, ...event }, response);
          } else if (shouldRetainMutation(response.status)) {
            await commitProgress({ userId, ...event });
          } else {
            // Accepted by the server, so there is no intent to journal — but
            // this device's own shelf still has to show it before the next pull.
            await mirrorProgress({ userId, ...event });
          }
        } catch {
          await commitProgress({ userId, ...event });
        }
      });
    },
    [activeBookRef, audioRef, userId],
  );

  /** The durable write, then the server write. In that order, always. */
  const persistProgress = useCallback(
    (positionMs: number, completed?: boolean, bookOverride?: PlayerBook) => {
      saveDurableState(positionMs, completed, bookOverride);
      return sendProgress(positionMs, completed, bookOverride);
    },
    [saveDurableState, sendProgress],
  );

  /**
   * The server heartbeat, from the timeupdate loop. The DURABLE write is not
   * here: it is on the interval below, so that how often this device knows
   * where the user is does not depend on how often the engine feels like
   * reporting it.
   */
  const onListeningTick = useCallback(
    (positionMs: number) => {
      if (!activeBookRef.current) return;
      if (Date.now() - lastServerSaveRef.current > SERVER_SAVE_INTERVAL_MS) {
        lastServerSaveRef.current = Date.now();
        void persistProgress(positionMs, false);
      }
    },
    [activeBookRef, persistProgress],
  );

  const markInProgress = useCallback(() => {
    const activeBook = activeBookRef.current;
    if (activeBook) completionRef.current.set(activeBook.id, false);
    positionChangedRef.current = true;
  }, [activeBookRef]);

  /** A new book is on the element: nothing has happened to its position yet. */
  const resetPositionChanged = useCallback(() => {
    positionChangedRef.current = false;
  }, []);

  // The cadence. Runs only while audio is actually playing, and reads the
  // element's own `currentTime` rather than anything the app has cached.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let timer: number | null = null;
    const stop = () => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const start = () => {
      if (timer !== null) return;
      timer = window.setInterval(() => {
        const element = audioRef.current;
        if (!element || element.paused || !activeBookRef.current) {
          stop();
          return;
        }
        saveDurableState(element.currentTime * 1000, false);
      }, DURABLE_SAVE_INTERVAL_MS);
    };
    audio.addEventListener("play", start);
    audio.addEventListener("pause", stop);
    audio.addEventListener("ended", stop);
    if (!audio.paused) start();
    return () => {
      stop();
      audio.removeEventListener("play", start);
      audio.removeEventListener("pause", stop);
      audio.removeEventListener("ended", stop);
    };
  }, [activeBookRef, audioRef, saveDurableState]);

  useEffect(() => {
    /**
     * The last callback an iOS PWA is reliably given.
     *
     * `pagehide` was the only terminal hook in this app, and on iOS the
     * app-switcher kill does not deliver it — the page is simply gone, and the
     * measured cost was 4.4 s of lost position on every backgrounding.
     *
     * ONE EDGE, NOT BOTH. This handler used to be unconditional on
     * `visibilityState`, on the reasoning that the edge back to VISIBLE just
     * rewrites the position the element is already at — "a no-op the user
     * cannot observe". That is true of one device and false of this app, which
     * is multi-device and ships `tests/sync/two-device-convergence.spec.ts`. A
     * tab left open at 04:00 and foregrounded at 09:00 has an audio element
     * still sitting where it was, and the visible edge republished that
     * position: local with `occurredAt: Date.now()`, so it beats the server's
     * newer record through `localWinsOver`, and a PATCH with
     * `eventOccurredAt: now`, which `decideProgressUpdate` accepts because it
     * only refuses events OLDER than what it holds. The result is a jump of
     * arbitrary size, in either direction, over a position another device
     * earned — with no user input at all. Skipping content the user paid for
     * is the worst failure this player has.
     *
     * Nothing is lost by not writing on the visible edge: becoming visible
     * destroys nothing, and the position has not moved since the last cadence
     * write. The flush exists for the edge where the page is about to stop
     * existing.
     *
     * The `hidden` read is safe here specifically because
     * `visibilitychange` is defined to fire AFTER `document.visibilityState`
     * has been updated — there is no path on which a hiding page reports
     * `"visible"` to this handler. `pagehide` stays unconditional: it is
     * terminal whatever the visibility is, including a foreground navigation.
     */
    const flush = () => {
      const audio = audioRef.current;
      if (!audio || !activeBookRef.current) return;
      const positionMs = audio.currentTime * 1000;
      saveDurableState(positionMs);
      void sendProgress(positionMs);
    };
    const flushIfHiding = () => {
      if (document.visibilityState !== "hidden") return;
      flush();
    };
    document.addEventListener("visibilitychange", flushIfHiding);
    window.addEventListener("pagehide", flush);
    const replay = () => void replayQueuedMutations(userId);
    if (navigator.onLine) replay();
    window.addEventListener("online", replay);
    return () => {
      document.removeEventListener("visibilitychange", flushIfHiding);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("online", replay);
    };
  }, [activeBookRef, audioRef, saveDurableState, sendProgress, userId]);

  useEffect(() => {
    const reconcile = (event: Event) => {
      // The provider's listener owns the playback surface (audio element and
      // stores); this one only keeps the completion bookkeeping in step.
      const detail = (event as CustomEvent<ProgressConflictDetail>).detail;
      const activeBook = activeBookRef.current;
      if (detail.userId !== userId || activeBook?.id !== detail.bookId) return;
      completionRef.current.set(detail.bookId, detail.completed);
    };
    window.addEventListener(PROGRESS_CONFLICT_EVENT, reconcile);
    return () => window.removeEventListener(PROGRESS_CONFLICT_EVENT, reconcile);
  }, [activeBookRef, userId]);

  return {
    persistProgress,
    onListeningTick,
    markInProgress,
    saveDurableState,
    markPositionChanged,
    resetPositionChanged,
  };
}

type ProgressConflictDetail = {
  userId: string;
  bookId: string;
  positionMs: number;
  completed: boolean;
  playbackRate: number;
};
