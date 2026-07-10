"use client";

import { RefObject, useCallback, useEffect, useRef, useState } from "react";

import type { PlayerChapter } from "@/domain/player";
import { isChapterEnding, selectCurrentChapter } from "@/lib/playback-core";

export type SleepMode = { kind: "time"; endsAt: number } | { kind: "chapter" } | null;

/** Sleep timer state machine: fixed durations plus stop-at-chapter-end. */
export function useSleepTimer(audioRef: RefObject<HTMLAudioElement | null>) {
  const [sleepMode, setSleepMode] = useState<SleepMode>(null);
  const sleepModeRef = useRef<SleepMode>(null);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    sleepModeRef.current = sleepMode;
  }, [sleepMode]);

  const clearSleep = useCallback(() => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    setSleepMode(null);
  }, []);

  const setSleepMinutes = useCallback(
    (minutes: number) => {
      clearSleep();
      setSleepMode({ kind: "time", endsAt: Date.now() + minutes * 60_000 });
      timeoutRef.current = window.setTimeout(() => {
        audioRef.current?.pause();
        setSleepMode(null);
      }, minutes * 60_000);
    },
    [audioRef, clearSleep],
  );

  const setSleepAtChapterEnd = useCallback(() => {
    clearSleep();
    setSleepMode({ kind: "chapter" });
  }, [clearSleep]);

  /** Called from the audio timeupdate loop; pauses exactly once at the boundary. */
  const onTimeUpdate = useCallback((audio: HTMLAudioElement, chapters: PlayerChapter[]) => {
    if (sleepModeRef.current?.kind !== "chapter") return;
    const positionMs = audio.currentTime * 1000;
    const chapter = selectCurrentChapter(chapters, positionMs);
    if (chapter && isChapterEnding(chapter, positionMs)) {
      audio.pause();
      audio.currentTime = chapter.endMs / 1000;
      setSleepMode(null);
    }
  }, []);

  return { sleepMode, setSleepMinutes, setSleepAtChapterEnd, clearSleep, onTimeUpdate };
}
