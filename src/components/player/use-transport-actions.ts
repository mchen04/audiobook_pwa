"use client";

import { RefObject, useMemo, useRef } from "react";

import type { PlaybackAction } from "@/domain/playback-history";
import type { PlayerBook, PlayerChapter } from "@/domain/player";
import type { PlaybackWriteSource } from "@/lib/playback-core";

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
  saveDurableState,
  markPositionChanged,
  recordAction,
}: {
  audioRef: RefObject<HTMLAudioElement | null>;
  activeBookRef: RefObject<PlayerBook | null>;
  suppressNextPauseRef: RefObject<boolean>;
  timeStore: PlaybackTimeStore;
  persistProgress: (
    source: PlaybackWriteSource,
    positionMs: number,
    completed?: boolean,
    bookOverride?: PlayerBook,
  ) => Promise<void>;
  /** Synchronous durable write; see `use-progress-persistence`. */
  saveDurableState: (
    source: PlaybackWriteSource,
    positionMs?: number,
    completed?: boolean,
    bookOverride?: PlayerBook,
  ) => void;
  markPositionChanged: () => void;
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
        if (audio && activeBookRef.current) void persistProgress("seek", audio.currentTime * 1000);
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
      // What the element ACCEPTED, not what it was asked for. `bounded` is
      // clamped to `activeBook.durationMs`, which is metadata computed at import
      // from the file's frame headers; the element clamps to the media it
      // actually decoded. When the first is longer than the second — an
      // estimated MP3 duration, a truncated download — a seek to the end
      // durably records a position past the real end of the audio, and nothing
      // corrects it while the user is paused because the cadence only runs
      // during playback. `resolveStartPosition` reads that record back, decides
      // the book is at its very end and restarts it from zero: a seek that
      // lands the user near the end of a book they have not finished throws
      // their place away on the next open.
      const settledMs = settledPositionMs(audio, bounded);
      timeStore.write(settledMs);
      // Durable at once, not in 800 ms. The debounce coalesces SERVER writes,
      // which is all it was ever for; leaving the local position behind it lost
      // the seek outright whenever the next thing to happen was
      // `cancelSeekPersist` — seek while paused, then leave the player, and
      // there was no `pause` event coming to save it either.
      markPositionChanged();
      saveDurableState("seek", settledMs);
      persistSeekSoon();
      recordAction(action, settledMs, previousPositionMs, description);
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
          markPositionChanged();
          void persistProgress("ended", activeBook.durationMs, true);
          recordAction("finished", activeBook.durationMs);
        },
        restart() {
          const audio = audioRef.current;
          if (!audio || !activeBookRef.current) return;
          cancelSeekPersist();
          const previousPositionMs = audio.currentTime * 1000;
          audio.currentTime = 0;
          timeStore.write(0);
          markPositionChanged();
          void persistProgress("seek", 0, false);
          recordAction("restarted", 0, previousPositionMs);
        },
      },
    };
  }, [
    activeBookRef,
    audioRef,
    markPositionChanged,
    persistProgress,
    recordAction,
    saveDurableState,
    suppressNextPauseRef,
    timeStore,
  ]);
}

/**
 * Where the element ended up after being told to seek.
 *
 * Read back rather than assumed, but only once there is something to read.
 * Before `HAVE_METADATA` the element has no duration to clamp against and, in
 * WebKit, no media player object to ask — `currentTime` answers 0 — so writing
 * the read-back at that point would turn a seek into a jump to the start of the
 * book, which is a far worse failure than the one this exists to prevent. Until
 * then the request is the best information anyone has.
 */
function settledPositionMs(audio: HTMLAudioElement, requestedMs: number): number {
  if (audio.readyState < audio.HAVE_METADATA) return requestedMs;
  const settled = audio.currentTime * 1000;
  return Number.isFinite(settled) && settled >= 0 ? settled : requestedMs;
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
