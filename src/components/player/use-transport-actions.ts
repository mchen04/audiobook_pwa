"use client";

import { RefObject, useMemo, useRef } from "react";

import type { PlaybackAction, PlayerBook, PlayerChapter } from "@/domain/player";

import type { PlaybackTimeStore } from "./playback-time-store";

/**
 * Transport surface of the player: play/pause/seek/skip/chapter moves and the
 * finish/restart jumps, all recorded to history and persisted. Every
 * dependency is referentially stable, so the returned objects are created
 * once for the provider's lifetime.
 */
export function useTransportActions({
  audioRef,
  activeBookRef,
  suppressNextPauseRef,
  timeStore,
  persistProgress,
  recordAction,
}: {
  audioRef: RefObject<HTMLAudioElement | null>;
  activeBookRef: RefObject<PlayerBook | null>;
  suppressNextPauseRef: RefObject<boolean>;
  timeStore: PlaybackTimeStore;
  persistProgress: (
    positionMs: number,
    completed?: boolean,
    bookOverride?: PlayerBook,
  ) => Promise<void>;
  recordAction: (
    action: PlaybackAction,
    positionMs?: number,
    previousPositionMs?: number | null,
    description?: string | null,
  ) => void;
}) {
  const seekPersistTimerRef = useRef<number | null>(null);

  return useMemo(() => {
    const cancelSeekPersist = () => {
      if (seekPersistTimerRef.current !== null) {
        window.clearTimeout(seekPersistTimerRef.current);
        seekPersistTimerRef.current = null;
      }
    };
    // Rapid seek taps coalesce into one server write. The position is read at
    // fire time, so a later pause/finish/restart never loses to a stale value.
    const persistSeekSoon = () => {
      cancelSeekPersist();
      seekPersistTimerRef.current = window.setTimeout(() => {
        seekPersistTimerRef.current = null;
        const audio = audioRef.current;
        if (audio && activeBookRef.current) void persistProgress(audio.currentTime * 1000);
      }, 800);
    };
    const seekWithAction = (
      positionMs: number,
      action: PlaybackAction,
      description: string | null = null,
    ) => {
      const audio = audioRef.current;
      const activeBook = activeBookRef.current;
      if (!audio || !activeBook) return;
      const bounded = Math.min(Math.max(positionMs, 0), activeBook.durationMs);
      const previousPositionMs = audio.currentTime * 1000;
      audio.currentTime = bounded / 1000;
      timeStore.write(bounded);
      persistSeekSoon();
      recordAction(action, bounded, previousPositionMs, description);
    };

    return {
      cancelSeekPersist,
      actions: {
        play() {
          if (audioRef.current) safePlay(audioRef.current);
        },
        toggle() {
          const audio = audioRef.current;
          if (!audio) return;
          if (audio.paused) safePlay(audio);
          else audio.pause();
        },
        pause() {
          audioRef.current?.pause();
        },
        seek(positionMs: number) {
          seekWithAction(positionMs, "seek");
        },
        restoreHistoryPosition(positionMs: number) {
          seekWithAction(positionMs, "history_restore");
        },
        moveToChapter(chapter: PlayerChapter, direction: "previous" | "next") {
          seekWithAction(
            chapter.startMs,
            direction === "previous" ? "previous_chapter" : "next_chapter",
            chapter.title,
          );
        },
        skip(deltaMs: number) {
          seekWithAction(
            (audioRef.current?.currentTime || 0) * 1000 + deltaMs,
            deltaMs < 0 ? "skip_back" : "skip_forward",
            `${Math.round(Math.abs(deltaMs) / 1000)} seconds`,
          );
        },
        markFinished() {
          const audio = audioRef.current;
          const activeBook = activeBookRef.current;
          if (!audio || !activeBook) return;
          cancelSeekPersist();
          if (!audio.paused) suppressNextPauseRef.current = true;
          audio.pause();
          audio.currentTime = activeBook.durationMs / 1000;
          timeStore.write(activeBook.durationMs);
          void persistProgress(activeBook.durationMs, true);
          recordAction("finished", activeBook.durationMs);
        },
        restart() {
          const audio = audioRef.current;
          if (!audio || !activeBookRef.current) return;
          cancelSeekPersist();
          const previousPositionMs = audio.currentTime * 1000;
          audio.currentTime = 0;
          timeStore.write(0);
          void persistProgress(0, false);
          recordAction("restarted", 0, previousPositionMs);
        },
      },
    };
  }, [activeBookRef, audioRef, persistProgress, recordAction, suppressNextPauseRef, timeStore]);
}

// Autoplay can be blocked before the first user activation; a rejected play()
// must stay silent and paused instead of surfacing an uncaught rejection.
// Playing from the very end restarts the book, otherwise the press would only
// play the residual sliver before `ended` pauses it again.
export function safePlay(audio: HTMLAudioElement): void {
  if (Number.isFinite(audio.duration) && audio.duration - audio.currentTime < 1) {
    audio.currentTime = 0;
  }
  audio.play().catch(() => undefined);
}
