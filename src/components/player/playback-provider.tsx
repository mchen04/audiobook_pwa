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
import { afterLaunchPaint } from "@/lib/launch-revalidation";
import { createListeningTracker, queueListeningSession } from "@/lib/listening-tracker";
import {
  loadPlaybackHistory,
  PLAYBACK_HISTORY_LIMIT,
  replayPlaybackHistory,
  storePlaybackAction,
} from "@/lib/playback-history";
import {
  markPausedNow,
  freshestPosition,
  localWinsOver,
  readLocalProgress,
  readMsSinceLastPause,
  resolveStartPosition,
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
  const trackerRef = useRef(createListeningTracker(queueListeningSession(userId)));
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
  const {
    persistProgress,
    onListeningTick,
    markInProgress,
    saveDurableState,
    markPositionChanged,
    resetPositionChanged,
  } = useProgressPersistence(userId, audioRef, activeBookRef);
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
    const refresh = () => {
      void fetchPreferences(userId)
        .then((fresh) => {
          if (active) setPreferences(fresh);
        })
        .catch(() => undefined);
    };
    // This device's own answer is applied at once; the server's is revalidation
    // and waits for the launch to paint. `fetchPreferences` used to fire from
    // mount, which put a network round trip and a Postgres query in front of
    // the frame the launch is measured on for every page carrying the player.
    void Promise.resolve()
      .then(() => {
        if (active) setPreferences(readCachedPreferences(userId));
      })
      .catch(() => undefined);
    const cancelRevalidation = afterLaunchPaint(refresh);
    const replayHistory = () => void replayPlaybackHistory(userId).catch(() => undefined);
    if (navigator.onLine) replayHistory();
    window.addEventListener("online", refresh);
    window.addEventListener("online", replayHistory);
    return () => {
      active = false;
      cancelRevalidation();
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
      const positionMs = audio.currentTime * 1000;
      // The marker records an absence from a specific book, so there is nothing
      // to mark when no book is loaded.
      if (activeBookRef.current) {
        markPausedNow(userId, activeBookRef.current.id);
        trackerRef.current.end(activeBookRef.current.id, positionMs);
      }
      void persistProgress(positionMs);
      recordAction("pause", positionMs);
    };
    const markEnded = () => {
      setIsPlaying(false);
      const endPositionMs = activeBookRef.current?.durationMs || audio.currentTime * 1000;
      if (activeBookRef.current) trackerRef.current.end(activeBookRef.current.id, endPositionMs);
      markPositionChanged();
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
    markPositionChanged,
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
    saveDurableState,
    markPositionChanged,
    recordAction,
  });

  // Every dependency here is referentially stable, so the actions object is
  // created once; consumers can put it (or any method) in effect deps safely.
  const actions = useMemo(() => {
    return {
      updatePreferences(patch: Partial<PlayerPreferences>) {
        // The save is deliberately OUTSIDE the state updater. React may invoke
        // an updater more than once for a single call — StrictMode does it on
        // every render in development — so a PATCH fired from inside one is
        // sent twice, and a state updater is required to be pure regardless.
        // The ref is written here rather than left to its effect so two
        // updates in the same tick still compose.
        const current = preferencesRef.current;
        const next = { ...current, ...patch };
        preferencesRef.current = next;
        setPreferences(next);
        void savePreferences(userId, current, patch);
      },
      loadBook(nextBook: PlayerBook, autoplay = false, historySnapshot?: PlaybackHistorySnapshot) {
        const audio = audioRef.current;
        if (!audio) return;
        if (activeBookRef.current?.id !== nextBook.id) {
          const previousBook = activeBookRef.current;
          if (previousBook) {
            // The previous book's position is made durable BEFORE the seek
            // debounce is dropped, because dropping it is what used to throw
            // away a seek the user made while paused.
            const previousPositionMs = audio.currentTime * 1000;
            if (!audio.paused) suppressNextPauseRef.current = true;
            // `completed` is deliberately NOT passed. A literal `false` here
            // un-finished the book the user had just finished — locally and on
            // the server — and it fired by itself on the autoplay-next path,
            // where the finished book is ALWAYS the previous one. Left
            // undefined, both writes fall through to the completion this book
            // actually has (`completionRef`, then `previousBook.completed`), so
            // switching books records where the user was without ever making a
            // claim about whether they finished it.
            saveDurableState(previousPositionMs, undefined, previousBook);
            void persistProgress(previousPositionMs, undefined, previousBook);
            cancelSeekPersist();
            if (!audio.paused) audio.pause();
            trackerRef.current.end(previousBook.id, previousPositionMs);
          } else {
            cancelSeekPersist();
          }
          trackerRef.current.reset();

          const localProgress = readLocalProgress(userId, nextBook.id);
          const localIsFresher = localWinsOver(localProgress, nextBook.initialProgressOccurredAt);
          const { startAtMs, appliedRewindMs } = resolveStartPosition({
            storedPositionMs: freshestPosition({
              local: localProgress,
              serverPositionMs: nextBook.initialPositionMs,
              serverOccurredAt: nextBook.initialProgressOccurredAt,
            }),
            durationMs: nextBook.durationMs,
            smartRewindEnabled: preferencesRef.current.smartRewind,
            msSinceLastPause: readMsSinceLastPause(userId, nextBook.id),
          });
          // The rewind is a one-shot listening aid: refresh the pause marker so
          // reopening the book again does not walk the position further back.
          if (appliedRewindMs > 0) markPausedNow(userId, nextBook.id);
          // The rate is part of where the user left off. A relaunch with no
          // network reads the book's server-side rate from whatever the mirror
          // last held, which is 1.0 for a book whose 1.6x was only ever set on
          // this device — so this device's own record wins whenever it also
          // owns the position.
          const startRate =
            localIsFresher && localProgress?.playbackRate
              ? localProgress.playbackRate
              : nextBook.initialPlaybackRate;

          audio.src = nextBook.mediaUrl;
          audio.currentTime = startAtMs / 1000;
          audio.playbackRate = startRate;
          activeBookRef.current = nextBook;
          // Nothing has happened to this book's position yet on this open, so a
          // close with no listening must not write the (possibly rewound)
          // start back as if the user had chosen it.
          resetPositionChanged();
          setBook(nextBook);
          setHistory([]);
          timeStore.write(startAtMs);
          setRateState(startRate);
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
        markPositionChanged();
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
        const audio = audioRef.current;
        // Durable BEFORE anything is torn down. `cancelSeekPersist` used to run
        // first and `audio.pause()` on an already-paused element fires no
        // event, so leaving the player after a seek made while paused lost the
        // seek entirely — and `removeAttribute("src")` then zeroes
        // `currentTime`, so there is nothing left to read afterwards either.
        if (audio && activeBookRef.current) {
          const positionMs = audio.currentTime * 1000;
          saveDurableState(positionMs);
          void persistProgress(positionMs);
        }
        cancelSeekPersist();
        if (audio) {
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
        }
        resetPositionChanged();
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
    markPositionChanged,
    persistProgress,
    recordAction,
    resetPositionChanged,
    saveDurableState,
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
