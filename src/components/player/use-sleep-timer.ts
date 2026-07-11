"use client";

import { RefObject, useCallback, useEffect, useRef, useState } from "react";

import type { PlayerChapter } from "@/domain/player";
import { CHAPTER_END_EPSILON_MS, selectCurrentChapter } from "@/lib/playback-core";

export type SleepMode = { kind: "time"; endsAt: number } | { kind: "chapter" } | null;

/** Sleep timer state machine: fixed durations plus stop-at-chapter-end. */
export function useSleepTimer(audioRef: RefObject<HTMLAudioElement | null>) {
  const [sleepMode, setSleepMode] = useState<SleepMode>(null);
  const sleepModeRef = useRef<SleepMode>(null);
  const timeoutRef = useRef<number | null>(null);
  const chapterEndRef = useRef<number | null>(null);

  useEffect(() => {
    sleepModeRef.current = sleepMode;
  }, [sleepMode]);

  const clearSleep = useCallback(() => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    chapterEndRef.current = null;
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

  const setSleepAtChapterEnd = useCallback(
    (positionMs: number, chapters: PlayerChapter[]) => {
      clearSleep();
      chapterEndRef.current = selectCurrentChapter(chapters, positionMs)?.endMs || null;
      if (chapterEndRef.current !== null) setSleepMode({ kind: "chapter" });
    },
    [clearSleep],
  );

  /** Called from the audio timeupdate loop; pauses exactly once at the boundary. */
  const onTimeUpdate = useCallback((audio: HTMLAudioElement) => {
    if (sleepModeRef.current?.kind !== "chapter") return;
    const positionMs = audio.currentTime * 1000;
    const targetEndMs = chapterEndRef.current;
    if (targetEndMs !== null && positionMs >= targetEndMs - CHAPTER_END_EPSILON_MS) {
      audio.pause();
      audio.currentTime = targetEndMs / 1000;
      chapterEndRef.current = null;
      setSleepMode(null);
    }
  }, []);

  return { sleepMode, setSleepMinutes, setSleepAtChapterEnd, clearSleep, onTimeUpdate };
}
