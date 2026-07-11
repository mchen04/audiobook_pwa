"use client";

import { RefObject, useCallback, useEffect, useRef } from "react";

import type { PlayerBook } from "@/domain/player";
import {
  queueProgress,
  reconcileProgressConflict,
  replayQueuedMutations,
  shouldRetainMutation,
  nextDeviceSequence,
  toProgressBody,
  withProgressMutationLock,
} from "@/lib/offline-sync";
import { getDeviceId, saveLocalPosition } from "@/lib/playback-core";

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
  const completionRef = useRef(new Map<string, boolean>());

  const persistProgress = useCallback(
    async (positionMs: number, completed?: boolean, bookOverride?: PlayerBook) => {
      const activeBook = bookOverride || activeBookRef.current;
      if (!activeBook) return;
      await withProgressMutationLock(activeBook.id, async () => {
        if (completed !== undefined) completionRef.current.set(activeBook.id, completed);
        const durableCompleted =
          completed ?? completionRef.current.get(activeBook.id) ?? activeBook.completed;
        saveLocalPosition(userId, activeBook.id, positionMs);
        const event = {
          bookId: activeBook.id,
          deviceId: getDeviceId(),
          deviceSequence: await nextDeviceSequence(activeBook.id),
          positionMs: Math.round(positionMs),
          playbackRate: audioRef.current?.playbackRate || 1,
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
            await queueProgress({ userId, ...event });
          }
        } catch {
          await queueProgress({ userId, ...event });
        }
      });
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
        completionRef.current.set(activeBook.id, false);
        void persistProgress(positionMs, false);
      }
    },
    [activeBookRef, persistProgress, userId],
  );

  const markInProgress = useCallback(() => {
    const activeBook = activeBookRef.current;
    if (activeBook) completionRef.current.set(activeBook.id, false);
  }, [activeBookRef]);

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

  useEffect(() => {
    const reconcile = (event: Event) => {
      const detail = (event as CustomEvent<ProgressConflictDetail>).detail;
      const activeBook = activeBookRef.current;
      if (detail.userId !== userId || activeBook?.id !== detail.bookId) return;
      completionRef.current.set(detail.bookId, detail.completed);
      if (audioRef.current) {
        audioRef.current.currentTime = detail.positionMs / 1000;
        audioRef.current.playbackRate = detail.playbackRate;
      }
    };
    window.addEventListener("chapterline:progress-conflict", reconcile);
    return () => window.removeEventListener("chapterline:progress-conflict", reconcile);
  }, [activeBookRef, audioRef, userId]);

  return { persistProgress, onListeningTick, markInProgress };
}

type ProgressConflictDetail = {
  userId: string;
  bookId: string;
  positionMs: number;
  completed: boolean;
  playbackRate: number;
};
