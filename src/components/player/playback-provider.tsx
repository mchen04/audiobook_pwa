"use client";

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { PlayerBook, PlayerChapter } from "@/domain/player";
import { createListeningTracker } from "@/lib/listening-tracker";
import {
  markPausedNow,
  freshestPosition,
  readLocalProgress,
  readMsSinceLastPause,
  resolveStartPosition,
  saveLocalPosition,
  selectCurrentChapter,
} from "@/lib/playback-core";
import {
  DEFAULT_PREFERENCES,
  fetchPreferences,
  type PlayerPreferences,
  readCachedPreferences,
  savePreferences,
} from "@/lib/preferences";

import {
  setMediaSessionMetadata,
  setMediaSessionPlaybackState,
  syncMediaSessionPosition,
  useMediaSession,
} from "./use-media-session";
import { useProgressPersistence } from "./use-progress-persistence";
import { type SleepMode, useSleepTimer } from "./use-sleep-timer";
import { useTabArbitration } from "./use-tab-arbitration";

type PlaybackContextValue = {
  userId: string;
  book: PlayerBook | null;
  currentTimeMs: number;
  isPlaying: boolean;
  playbackRate: number;
  currentChapter: PlayerChapter | null;
  sleepMode: SleepMode;
  preferences: PlayerPreferences;
  /** Bumped each time a book plays to its end; consumers react to completion. */
  lastEndedAt: number;
  updatePreferences: (patch: Partial<PlayerPreferences>) => void;
  loadBook: (book: PlayerBook, autoplay?: boolean) => void;
  toggle: () => void;
  pause: () => void;
  seek: (positionMs: number) => void;
  skip: (deltaMs: number) => void;
  setPlaybackRate: (rate: number) => void;
  setSleepMinutes: (minutes: number) => void;
  setSleepAtChapterEnd: () => void;
  clearSleep: () => void;
  markFinished: () => void;
  restart: () => void;
  unloadBook: () => void;
};

const PlaybackContext = createContext<PlaybackContextValue | null>(null);

export function PlaybackProvider({ children, userId }: { children: ReactNode; userId: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeBookRef = useRef<PlayerBook | null>(null);
  const trackerRef = useRef(createListeningTracker());
  const suppressNextPauseRef = useRef(false);
  const preferencesRef = useRef<PlayerPreferences>(DEFAULT_PREFERENCES);
  const [book, setBook] = useState<PlayerBook | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setRateState] = useState(1);
  const [preferences, setPreferences] = useState<PlayerPreferences>(DEFAULT_PREFERENCES);
  const [lastEndedAt, setLastEndedAt] = useState(0);

  const announcePlaying = useTabArbitration(audioRef);
  const { persistProgress, onListeningTick, markInProgress } = useProgressPersistence(
    userId,
    audioRef,
    activeBookRef,
  );
  const {
    sleepMode,
    setSleepMinutes,
    setSleepAtChapterEnd: setSleepAtChapterEndTarget,
    clearSleep,
    onTimeUpdate: onSleepTick,
  } = useSleepTimer(audioRef);

  const setSleepAtChapterEnd = useCallback(() => {
    const activeBook = activeBookRef.current;
    const audio = audioRef.current;
    if (activeBook && audio) {
      setSleepAtChapterEndTarget(audio.currentTime * 1000, activeBook.chapters);
    }
  }, [setSleepAtChapterEndTarget]);

  useEffect(() => {
    activeBookRef.current = book;
  }, [book]);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  useEffect(() => {
    localStorage.setItem("chapterline:active-user", userId);
    let active = true;
    void Promise.resolve()
      .then(() => {
        if (active) setPreferences(readCachedPreferences(userId));
        return fetchPreferences(userId);
      })
      .then((fresh) => {
        if (active) setPreferences(fresh);
      })
      .catch(() => undefined);
    const refresh = () => {
      void fetchPreferences(userId).then((fresh) => {
        if (active) setPreferences(fresh);
      });
    };
    window.addEventListener("online", refresh);
    return () => {
      active = false;
      window.removeEventListener("online", refresh);
    };
  }, [userId]);

  const updatePreferences = useCallback(
    (patch: Partial<PlayerPreferences>) => {
      setPreferences((current) => {
        void savePreferences(userId, current, patch);
        return { ...current, ...patch };
      });
    },
    [userId],
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const updateTime = () => {
      const positionMs = audio.currentTime * 1000;
      setCurrentTimeMs(positionMs);
      // Programmatic seeks also fire timeupdate; only actual listening may
      // persist, otherwise merely opening a book would overwrite the position.
      if (!audio.paused) onListeningTick(positionMs);
      if (activeBookRef.current) {
        onSleepTick(audio);
        syncMediaSessionPosition(audio, activeBookRef.current.durationMs);
      }
    };
    const markPlaying = () => {
      markInProgress();
      setIsPlaying(true);
      trackerRef.current.begin(audio.currentTime * 1000);
      announcePlaying();
      setMediaSessionPlaybackState("playing");
    };
    const markPaused = () => {
      setIsPlaying(false);
      setMediaSessionPlaybackState("paused");
      if (suppressNextPauseRef.current) {
        suppressNextPauseRef.current = false;
        return;
      }
      markPausedNow();
      const positionMs = audio.currentTime * 1000;
      if (activeBookRef.current) {
        saveLocalPosition(userId, activeBookRef.current.id, positionMs);
        trackerRef.current.end(activeBookRef.current.id, positionMs);
      }
      void persistProgress(positionMs);
    };
    const markEnded = () => {
      setIsPlaying(false);
      const endPositionMs = activeBookRef.current?.durationMs || audio.currentTime * 1000;
      if (activeBookRef.current) trackerRef.current.end(activeBookRef.current.id, endPositionMs);
      void persistProgress(endPositionMs, true);
      setLastEndedAt(Date.now());
    };

    audio.addEventListener("timeupdate", updateTime);
    audio.addEventListener("play", markPlaying);
    audio.addEventListener("pause", markPaused);
    audio.addEventListener("ended", markEnded);
    return () => {
      audio.removeEventListener("timeupdate", updateTime);
      audio.removeEventListener("play", markPlaying);
      audio.removeEventListener("pause", markPaused);
      audio.removeEventListener("ended", markEnded);
    };
  }, [announcePlaying, markInProgress, onListeningTick, onSleepTick, persistProgress, userId]);

  const seek = useCallback(
    (positionMs: number) => {
      const audio = audioRef.current;
      const activeBook = activeBookRef.current;
      if (!audio || !activeBook) return;
      const bounded = Math.min(Math.max(positionMs, 0), activeBook.durationMs);
      audio.currentTime = bounded / 1000;
      setCurrentTimeMs(bounded);
      void persistProgress(bounded);
    },
    [persistProgress],
  );

  const loadBook = useCallback(
    (nextBook: PlayerBook, autoplay = false) => {
      const audio = audioRef.current;
      if (!audio) return;
      if (activeBookRef.current?.id !== nextBook.id) {
        const previousBook = activeBookRef.current;
        if (!audio.paused && previousBook) {
          const previousPositionMs = audio.currentTime * 1000;
          suppressNextPauseRef.current = true;
          audio.pause();
          saveLocalPosition(userId, previousBook.id, previousPositionMs);
          trackerRef.current.end(previousBook.id, previousPositionMs);
          void persistProgress(previousPositionMs, false, previousBook);
        }
        trackerRef.current.reset();

        const { startAtMs, appliedRewindMs } = resolveStartPosition({
          storedPositionMs: freshestPosition({
            local: readLocalProgress(userId, nextBook.id),
            serverPositionMs: nextBook.initialPositionMs,
            serverOccurredAt: nextBook.initialProgressOccurredAt,
          }),
          durationMs: nextBook.durationMs,
          smartRewindEnabled: preferencesRef.current.smartRewind,
          msSinceLastPause: readMsSinceLastPause(),
        });
        // The rewind is a one-shot listening aid: refresh the pause marker so
        // reopening the book again does not walk the position further back.
        if (appliedRewindMs > 0) markPausedNow();

        audio.src = nextBook.mediaUrl;
        audio.currentTime = startAtMs / 1000;
        audio.playbackRate = nextBook.initialPlaybackRate;
        activeBookRef.current = nextBook;
        setBook(nextBook);
        setCurrentTimeMs(startAtMs);
        setRateState(nextBook.initialPlaybackRate);
        setMediaSessionMetadata(nextBook);
      }
      if (autoplay) safePlay(audio);
    },
    [persistProgress, userId],
  );

  const play = useCallback(() => {
    if (audioRef.current) safePlay(audioRef.current);
  }, []);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) safePlay(audio);
    else audio.pause();
  }, []);

  const pause = useCallback(() => audioRef.current?.pause(), []);
  const skip = useCallback(
    (deltaMs: number) => seek((audioRef.current?.currentTime || 0) * 1000 + deltaMs),
    [seek],
  );
  const setPlaybackRate = useCallback(
    (rate: number) => {
      const bounded = Math.min(3, Math.max(0.5, rate));
      if (audioRef.current) audioRef.current.playbackRate = bounded;
      setRateState(bounded);
      // The rate is part of durable playback state, so it survives reloads
      // even when changed while paused.
      void persistProgress((audioRef.current?.currentTime || 0) * 1000);
    },
    [persistProgress],
  );

  const markFinished = useCallback(() => {
    const audio = audioRef.current;
    const activeBook = activeBookRef.current;
    if (!audio || !activeBook) return;
    if (!audio.paused) suppressNextPauseRef.current = true;
    audio.pause();
    audio.currentTime = activeBook.durationMs / 1000;
    setCurrentTimeMs(activeBook.durationMs);
    void persistProgress(activeBook.durationMs, true);
  }, [persistProgress]);

  const restart = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !activeBookRef.current) return;
    audio.currentTime = 0;
    setCurrentTimeMs(0);
    void persistProgress(0, false);
  }, [persistProgress]);

  const unloadBook = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    activeBookRef.current = null;
    setBook(null);
    setCurrentTimeMs(0);
    setIsPlaying(false);
  }, []);

  useEffect(() => {
    window.addEventListener("chapterline:unload-player", unloadBook);
    return () => window.removeEventListener("chapterline:unload-player", unloadBook);
  }, [unloadBook]);

  useEffect(() => {
    const reconcile = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          userId: string;
          bookId: string;
          positionMs: number;
          playbackRate: number;
        }>
      ).detail;
      if (detail.userId !== userId || activeBookRef.current?.id !== detail.bookId) return;
      setCurrentTimeMs(detail.positionMs);
      setRateState(detail.playbackRate);
    };
    window.addEventListener("chapterline:progress-conflict", reconcile);
    return () => window.removeEventListener("chapterline:progress-conflict", reconcile);
  }, [userId]);

  useMediaSession({ audioRef, preferencesRef, play, seek, skip });

  const currentChapter = useMemo(
    () => (book ? selectCurrentChapter(book.chapters, currentTimeMs) : null),
    [book, currentTimeMs],
  );

  const value = useMemo<PlaybackContextValue>(
    () => ({
      userId,
      book,
      currentTimeMs,
      isPlaying,
      playbackRate,
      currentChapter,
      sleepMode,
      preferences,
      lastEndedAt,
      updatePreferences,
      loadBook,
      toggle,
      pause,
      seek,
      skip,
      setPlaybackRate,
      setSleepMinutes,
      setSleepAtChapterEnd,
      clearSleep,
      markFinished,
      restart,
      unloadBook,
    }),
    [
      userId,
      book,
      currentTimeMs,
      isPlaying,
      playbackRate,
      currentChapter,
      sleepMode,
      preferences,
      lastEndedAt,
      updatePreferences,
      loadBook,
      toggle,
      pause,
      seek,
      skip,
      setPlaybackRate,
      setSleepMinutes,
      setSleepAtChapterEnd,
      clearSleep,
      markFinished,
      restart,
      unloadBook,
    ],
  );

  return (
    <PlaybackContext.Provider value={value}>
      {children}
      <audio ref={audioRef} preload="metadata" className="visually-hidden" />
    </PlaybackContext.Provider>
  );
}

export function usePlayback() {
  const context = useContext(PlaybackContext);
  if (!context) throw new Error("usePlayback must be used inside PlaybackProvider");
  return context;
}

// Autoplay can be blocked before the first user activation; a rejected play()
// must stay silent and paused instead of surfacing an uncaught rejection.
// Playing from the very end restarts the book, otherwise the press would only
// play the residual sliver before `ended` pauses it again.
function safePlay(audio: HTMLAudioElement): void {
  if (Number.isFinite(audio.duration) && audio.duration - audio.currentTime < 1) {
    audio.currentTime = 0;
  }
  audio.play().catch(() => undefined);
}
