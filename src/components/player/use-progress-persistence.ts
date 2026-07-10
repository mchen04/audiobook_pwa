"use client";

import { RefObject, useCallback, useEffect, useRef } from "react";

import type { PlayerBook } from "@/domain/player";
import { queueProgress, replayQueuedMutations, toProgressBody } from "@/lib/offline-sync";
import { getDeviceId, nextSequence, saveLocalPosition } from "@/lib/playback-core";

const LOCAL_SAVE_INTERVAL_MS = 5_000;
const SERVER_SAVE_INTERVAL_MS = 15_000;

/**
 * Durable progress: local position immediately, server writes on meaningful
 * events plus a listening heartbeat, offline queueing with replay on
 * reconnect, and a flush on page hide. A 409 answer seeks the audio to the
 * fresher position the server returned.
 */
export function useProgressPersistence(
  userId: string,
  audioRef: RefObject<HTMLAudioElement | null>,
  activeBookRef: RefObject<PlayerBook | null>,
) {
  const lastServerSaveRef = useRef(0);
  const lastLocalSaveRef = useRef(0);

  const persistProgress = useCallback(
    async (positionMs: number, completed = false) => {
      const activeBook = activeBookRef.current;
      if (!activeBook) return;
      const event = {
        bookId: activeBook.id,
        deviceId: getDeviceId(),
        deviceSequence: nextSequence(activeBook.id),
        positionMs: Math.round(positionMs),
        playbackRate: audioRef.current?.playbackRate || 1,
        completed,
        eventOccurredAt: new Date().toISOString(),
      };

      saveLocalPosition(userId, activeBook.id, positionMs);
      try {
        const response = await fetch(`/api/books/${activeBook.id}/progress`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: toProgressBody(event),
          keepalive: true,
        });
        if (response.status === 409) {
          const payload = (await response.json()) as { state?: { positionMs?: number } };
          if (typeof payload.state?.positionMs === "number" && audioRef.current) {
            audioRef.current.currentTime = payload.state.positionMs / 1000;
          }
        }
      } catch {
        queueProgress({ userId, ...event });
      }
    },
    [activeBookRef, audioRef, userId],
  );

  /** Heartbeat from the timeupdate loop while actually listening. */
  const onListeningTick = useCallback(
    (positionMs: number) => {
      const activeBook = activeBookRef.current;
      if (!activeBook) return;
      if (Date.now() - lastLocalSaveRef.current > LOCAL_SAVE_INTERVAL_MS) {
        lastLocalSaveRef.current = Date.now();
        saveLocalPosition(userId, activeBook.id, positionMs);
      }
      if (Date.now() - lastServerSaveRef.current > SERVER_SAVE_INTERVAL_MS) {
        lastServerSaveRef.current = Date.now();
        void persistProgress(positionMs);
      }
    },
    [activeBookRef, persistProgress, userId],
  );

  useEffect(() => {
    const flush = () => {
      if (audioRef.current && activeBookRef.current) {
        void persistProgress(audioRef.current.currentTime * 1000);
      }
    };
    window.addEventListener("pagehide", flush);
    const replay = () => void replayQueuedMutations(userId);
    if (navigator.onLine) replay();
    window.addEventListener("online", replay);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("online", replay);
    };
  }, [activeBookRef, audioRef, persistProgress, userId]);

  return { persistProgress, onListeningTick };
}
