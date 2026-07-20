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
  useSyncExternalStore,
} from "react";

import type {
  PlaybackAction,
  PlaybackHistoryEntry,
  PlaybackHistorySnapshot,
  PlayerBook,
  PlayerChapter,
} from "@/domain/player";
import { ACTIVE_USER_KEY, PROGRESS_CONFLICT_EVENT, UNLOAD_PLAYER_EVENT } from "@/lib/app-keys";
import { createListeningTracker } from "@/lib/listening-tracker";
import {
  loadPlaybackHistory,
  PLAYBACK_HISTORY_LIMIT,
  replayPlaybackHistory,
  storePlaybackAction,
} from "@/lib/playback-history";
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

import { createTimeStore, type PlaybackTimeStore } from "./playback-time-store";
import {
  setMediaSessionMetadata,
  setMediaSessionPlaybackState,
  syncMediaSessionPosition,
  useMediaSession,
} from "./use-media-session";
import { useProgressPersistence } from "./use-progress-persistence";
import { type SleepMode, useSleepTimer } from "./use-sleep-timer";
import { useTabArbitration } from "./use-tab-arbitration";
import { safePlay, useTransportActions } from "./use-transport-actions";

type PlaybackContextValue = {
  userId: string;
  book: PlayerBook | null;
  isPlaying: boolean;
  playbackRate: number;
  history: PlaybackHistoryEntry[];
  historyNotice: string | null;
  sleepMode: SleepMode;
  preferences: PlayerPreferences;
  /** Bumped each time a book plays to its end; consumers react to completion. */
  lastEndedAt: number;
  updatePreferences: (patch: Partial<PlayerPreferences>) => void;
  loadBook: (
    book: PlayerBook,
    autoplay?: boolean,
    historySnapshot?: PlaybackHistorySnapshot,
  ) => void;
  toggle: () => void;
  pause: () => void;
  seek: (positionMs: number) => void;
  restoreHistoryPosition: (positionMs: number) => void;
  moveToChapter: (chapter: PlayerChapter, direction: "previous" | "next") => void;
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
const PlaybackTimeContext = createContext<PlaybackTimeStore | null>(null);

export function PlaybackProvider({ children, userId }: { children: ReactNode; userId: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeBookRef = useRef<PlayerBook | null>(null);
  const trackerRef = useRef(createListeningTracker());
  const suppressNextPauseRef = useRef(false);
  const preferencesRef = useRef<PlayerPreferences>(DEFAULT_PREFERENCES);
  const positionSyncKeyRef = useRef("");
  const timeStore = useMemo(() => createTimeStore(), []);
  const [book, setBook] = useState<PlayerBook | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setRateState] = useState(1);
  const [history, setHistory] = useState<PlaybackHistoryEntry[]>([]);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
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
    setSleepMinutes: setSleepMinutesTarget,
    setSleepAtChapterEnd: setSleepAtChapterEndTarget,
    clearSleep: clearSleepTarget,
    onTimeUpdate: onSleepTick,
  } = useSleepTimer(audioRef);

  const recordAction = useCallback(
    (
      action: PlaybackAction,
      positionMs?: number,
      previousPositionMs: number | null = null,
      description: string | null = null,
    ) => {
      const activeBook = activeBookRef.current;
      const audio = audioRef.current;
      if (!activeBook || !audio) return;
      const now = new Date().toISOString();
      const entry: PlaybackHistoryEntry = {
        id: crypto.randomUUID(),
        action,
        positionMs: Math.round(positionMs ?? audio.currentTime * 1000),
        previousPositionMs: previousPositionMs === null ? null : Math.round(previousPositionMs),
        playbackRate: audio.playbackRate || 1,
        description,
        occurredAt: now,
        recordedAt: now,
      };
      setHistory((current) => [entry, ...current].slice(0, PLAYBACK_HISTORY_LIMIT));
      void storePlaybackAction(userId, activeBook.id, entry)
        .then((result) => {
          if (result === "stored") {
            setHistoryNotice(null);
            return;
          }
          setHistory((current) => current.filter((item) => item.id !== entry.id));
          if (result === "unavailable") {
            setHistoryNotice("Playback history is unavailable on this device.");
          }
        })
        .catch(() => {
          setHistory((current) => current.filter((item) => item.id !== entry.id));
          setHistoryNotice("Playback history is unavailable on this device.");
        });
    },
    [userId],
  );

  useEffect(() => {
    activeBookRef.current = book;
  }, [book]);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_USER_KEY, userId);
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
    const replayHistory = () => void replayPlaybackHistory(userId).catch(() => undefined);
    if (navigator.onLine) replayHistory();
    window.addEventListener("online", refresh);
    window.addEventListener("online", replayHistory);
    return () => {
      active = false;
      window.removeEventListener("online", refresh);
      window.removeEventListener("online", replayHistory);
    };
  }, [userId]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const updateTime = () => {
      const positionMs = audio.currentTime * 1000;
      timeStore.write(positionMs);
      // Programmatic seeks also fire timeupdate; only actual listening may
      // persist, otherwise merely opening a book would overwrite the position.
      if (!audio.paused) onListeningTick(positionMs);
      if (activeBookRef.current) {
        onSleepTick(audio);
        syncMediaSessionPosition(audio, activeBookRef.current.durationMs, positionSyncKeyRef);
      }
    };
    const markPlaying = () => {
      markInProgress();
      setIsPlaying(true);
      trackerRef.current.begin(audio.currentTime * 1000);
      announcePlaying();
      setMediaSessionPlaybackState("playing");
      recordAction("play");
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
      recordAction("pause", positionMs);
    };
    const markEnded = () => {
      setIsPlaying(false);
      const endPositionMs = activeBookRef.current?.durationMs || audio.currentTime * 1000;
      if (activeBookRef.current) trackerRef.current.end(activeBookRef.current.id, endPositionMs);
      void persistProgress(endPositionMs, true);
      recordAction("finished", endPositionMs);
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
  }, [
    announcePlaying,
    markInProgress,
    onListeningTick,
    onSleepTick,
    persistProgress,
    recordAction,
    timeStore,
    userId,
  ]);

  const { actions: transport, cancelSeekPersist } = useTransportActions({
    audioRef,
    activeBookRef,
    suppressNextPauseRef,
    timeStore,
    persistProgress,
    recordAction,
  });

  // Every dependency here is referentially stable, so the actions object is
  // created once; consumers can put it (or any method) in effect deps safely.
  const actions = useMemo(() => {
    return {
      updatePreferences(patch: Partial<PlayerPreferences>) {
        setPreferences((current) => {
          void savePreferences(userId, current, patch);
          return { ...current, ...patch };
        });
      },
      loadBook(nextBook: PlayerBook, autoplay = false, historySnapshot?: PlaybackHistorySnapshot) {
        const audio = audioRef.current;
        if (!audio) return;
        if (activeBookRef.current?.id !== nextBook.id) {
          cancelSeekPersist();
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
          setHistory([]);
          timeStore.write(startAtMs);
          setRateState(nextBook.initialPlaybackRate);
          setMediaSessionMetadata(nextBook);
          recordAction(
            "opened",
            startAtMs,
            null,
            appliedRewindMs > 0
              ? `Smart rewind ${Math.round(appliedRewindMs / 1000)} seconds`
              : null,
          );
        }
        void loadPlaybackHistory(userId, nextBook.id, historySnapshot)
          .catch(() => historySnapshot?.entries || [])
          .then((entries) => {
            if (activeBookRef.current?.id !== nextBook.id) return;
            setHistory((current) =>
              [...current, ...entries]
                .filter(
                  (entry, index, all) => all.findIndex((item) => item.id === entry.id) === index,
                )
                .slice(0, PLAYBACK_HISTORY_LIMIT),
            );
          });
        if (autoplay) safePlay(audio);
      },
      setPlaybackRate(rate: number) {
        const bounded = Math.min(3, Math.max(0.5, rate));
        if (audioRef.current) audioRef.current.playbackRate = bounded;
        setRateState(bounded);
        // The rate is part of durable playback state, so it survives reloads
        // even when changed while paused.
        void persistProgress((audioRef.current?.currentTime || 0) * 1000);
        recordAction("playback_rate", undefined, null, `${bounded}×`);
      },
      setSleepMinutes(minutes: number) {
        setSleepMinutesTarget(minutes);
        recordAction("sleep_timer", undefined, null, `${minutes} minutes`);
      },
      setSleepAtChapterEnd() {
        const activeBook = activeBookRef.current;
        const audio = audioRef.current;
        if (activeBook && audio) {
          setSleepAtChapterEndTarget(audio.currentTime * 1000, activeBook.chapters);
          recordAction("sleep_timer", undefined, null, "End of chapter");
        }
      },
      clearSleep() {
        clearSleepTarget();
        recordAction("sleep_timer_cleared");
      },
      unloadBook() {
        cancelSeekPersist();
        const audio = audioRef.current;
        if (audio) {
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
        }
        activeBookRef.current = null;
        setBook(null);
        setHistory([]);
        setHistoryNotice(null);
        timeStore.write(0);
        setIsPlaying(false);
      },
    };
  }, [
    cancelSeekPersist,
    clearSleepTarget,
    persistProgress,
    recordAction,
    setSleepAtChapterEndTarget,
    setSleepMinutesTarget,
    timeStore,
    userId,
  ]);

  useEffect(() => {
    window.addEventListener(UNLOAD_PLAYER_EVENT, actions.unloadBook);
    return () => window.removeEventListener(UNLOAD_PLAYER_EVENT, actions.unloadBook);
  }, [actions]);

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
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = detail.positionMs / 1000;
        audio.playbackRate = detail.playbackRate;
      }
      timeStore.write(detail.positionMs);
      setRateState(detail.playbackRate);
    };
    window.addEventListener(PROGRESS_CONFLICT_EVENT, reconcile);
    return () => window.removeEventListener(PROGRESS_CONFLICT_EVENT, reconcile);
  }, [timeStore, userId]);

  useMediaSession({
    audioRef,
    preferencesRef,
    play: transport.play,
    seek: transport.seek,
    skip: transport.skip,
  });

  const value = useMemo<PlaybackContextValue>(
    () => ({
      userId,
      book,
      isPlaying,
      playbackRate,
      history,
      historyNotice,
      sleepMode,
      preferences,
      lastEndedAt,
      ...transport,
      ...actions,
    }),
    [
      userId,
      book,
      isPlaying,
      playbackRate,
      history,
      historyNotice,
      sleepMode,
      preferences,
      lastEndedAt,
      transport,
      actions,
    ],
  );

  return (
    <PlaybackContext.Provider value={value}>
      <PlaybackTimeContext.Provider value={timeStore}>
        {children}
        <audio ref={audioRef} preload="metadata" className="visually-hidden" />
      </PlaybackTimeContext.Provider>
    </PlaybackContext.Provider>
  );
}

export function usePlayback() {
  const context = useContext(PlaybackContext);
  if (!context) throw new Error("usePlayback must be used inside PlaybackProvider");
  return context;
}

/** Current position in ms; re-renders the subscriber on every timeupdate. */
export function usePlaybackTime(): number {
  const store = useContext(PlaybackTimeContext);
  if (!store) throw new Error("usePlaybackTime must be used inside PlaybackProvider");
  return useSyncExternalStore(store.subscribe, store.read, readServerTime);
}

/**
 * Recomputes `derive` on every playback tick but re-renders the subscriber
 * only when the derived value changes. Constrained to primitives so a fresh
 * object per call can never trip React's snapshot-caching check.
 */
export function usePlaybackDerived<T extends string | number | boolean | null>(derive: () => T): T {
  const store = useContext(PlaybackTimeContext);
  if (!store) throw new Error("usePlaybackDerived must be used inside PlaybackProvider");
  return useSyncExternalStore(store.subscribe, derive, derive);
}

/**
 * Derives a primitive from the current position; recomputed per tick but the
 * subscriber re-renders only when the derived value changes. This is what the
 * read-along view leans on: cue lookups run every tick, re-renders only on
 * cue boundaries.
 */
export function usePlaybackTimeDerived<T extends string | number | boolean | null>(
  derive: (timeMs: number) => T,
): T {
  const store = useContext(PlaybackTimeContext);
  if (!store) throw new Error("usePlaybackTimeDerived must be used inside PlaybackProvider");
  return useSyncExternalStore(
    store.subscribe,
    () => derive(store.read()),
    () => derive(0),
  );
}

/** The chapter under the playhead; re-renders only when the chapter changes. */
export function useCurrentChapter(): PlayerChapter | null {
  const { book } = usePlayback();
  const store = useContext(PlaybackTimeContext);
  if (!store) throw new Error("useCurrentChapter must be used inside PlaybackProvider");
  return useSyncExternalStore(
    store.subscribe,
    () => (book ? selectCurrentChapter(book.chapters, store.read()) : null),
    readServerChapter,
  );
}

const readServerTime = () => 0;
const readServerChapter = () => null;
