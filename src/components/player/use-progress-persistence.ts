"use client";

import { RefObject, useEffect, useRef, useState } from "react";

import type { PlayerBook } from "@/domain/player";
import { replayQueuedMutations } from "@/lib/offline-sync";
import type { PlaybackWriteSource } from "@/lib/playback-core";

import { createProgressPersister, type ProgressPersister } from "./progress-persister";

/**
 * Durable progress, wired to React.
 *
 * The gate/cadence/flush policy itself lives in `createProgressPersister`,
 * which is framework-free and holds every semantic comment; this hook only
 * binds that engine to the refs the provider owns and to the DOM's lifecycle —
 * the audio element's play/pause/ended (which start and stop the cadence
 * timer), and the page's hide/pagehide edges (the terminal flush).
 */
export function useProgressPersistence(
  userId: string,
  audioRef: RefObject<HTMLAudioElement | null>,
  activeBookRef: RefObject<PlayerBook | null>,
): ProgressPersister {
  // The engine reads the user at call time, so an account switch re-points
  // every write without rebuilding the engine (and without losing the
  // completion bookkeeping it carries).
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  // The getters close over the refs but run only from event handlers, timers
  // and effects — never during render, which the rule cannot see through a
  // lazy initializer.
  // eslint-disable-next-line react-hooks/refs
  const [persister] = useState(() =>
    createProgressPersister({
      getUserId: () => userIdRef.current,
      getAudio: () => audioRef.current,
      getActiveBook: () => activeBookRef.current,
    }),
  );

  // The cadence timer runs only while audio is actually playing: the element's
  // own transport events are what start and stop the chain.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const start = persister.startCadence;
    const stop = persister.stopCadence;
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
  }, [audioRef, persister]);

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
    const flush = (source: PlaybackWriteSource) => {
      const audio = audioRef.current;
      if (!audio || !activeBookRef.current) return;
      // `persistProgress` IS the synchronous-durable-write-then-server-write
      // order this handler needs, and it is the one place that keeps the server
      // half from rejecting onto a page that is already going away.
      void persister.persistProgress(source, audio.currentTime * 1000);
    };
    // The two edges record themselves separately because they answer different
    // questions on a phone: `visibility-flush` says the page was backgrounded
    // and then nothing else wrote, while `pagehide-flush` says the page was
    // navigated away from or torn down. An app-switcher kill delivers neither.
    const flushIfHiding = () => {
      if (document.visibilityState !== "hidden") return;
      flush("visibility-flush");
    };
    const flushOnPagehide = () => flush("pagehide-flush");
    document.addEventListener("visibilitychange", flushIfHiding);
    window.addEventListener("pagehide", flushOnPagehide);
    const replay = () => void replayQueuedMutations(userId);
    if (navigator.onLine) replay();
    window.addEventListener("online", replay);
    return () => {
      document.removeEventListener("visibilitychange", flushIfHiding);
      window.removeEventListener("pagehide", flushOnPagehide);
      window.removeEventListener("online", replay);
    };
  }, [activeBookRef, audioRef, persister, userId]);

  return persister;
}
